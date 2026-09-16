import { createHash, createPublicKey, randomUUID, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import WebSocket from 'ws'
import { validateAgentParams, validateAgentWaitParams, validateChatAbortParams, validateChatSendParams, validateConnectParams } from '@openclaw/gateway-protocol'
import { isGatewayResponseFrame, isGatewayEventFrame } from '@openclaw/gateway-protocol/frame-guards'
import { PROTOCOL_VERSION } from '@openclaw/gateway-protocol/version'

export interface OpenClawEvent { runId: string; stream: string; data: Record<string, unknown>; seq?: number; ts?: number }
export interface RunResult { runId: string; status: 'ok' | 'error' | 'timeout' | 'cancelled'; text: string; error?: string; cancelConfirmed?: boolean }
export interface StartRunOptions {
  attemptId: string
  prompt: string
  /** Files already staged under the tenant's home, not paths on the API laptop. */
  files?: string[]
  timeoutMs?: number
  deadlineAt?: number
  onEvent?: (event: OpenClawEvent) => void
}
export class OpenClawRunError extends Error {
  constructor(message: string, public readonly quiescent: boolean, public readonly runId?: string) { super(message); this.name = 'OpenClawRunError' }
}
interface Identity { privateKeyPem: string; publicKeyPem: string }
export interface OpenClawClientOptions {
  tokenForTenant?: (tenant: number) => string | Promise<string>
  identityForTenant?: (tenant: number) => Identity | undefined | Promise<Identity | undefined>
  /** Tests may substitute another loopback port; public hosts are always refused. */
  urlForTenant?: (tenant: number) => string
  requestTimeoutMs?: number
  cancelTimeoutMs?: number
}
interface Run {
  id: string; tenant: number; sessionKey: string; deadline: number; text: string
  listeners: Set<(event: OpenClawEvent) => void>; childRuns: Set<string>; result?: RunResult
  timer?: NodeJS.Timeout; stopping?: Promise<void>; done: Promise<RunResult>; resolve: (result: RunResult) => void
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
export function openClawGatewayUrl(tenant: number): string {
  if (!Number.isInteger(tenant) || tenant < 1 || tenant > 10) throw new OpenClawRunError('Invalid OpenClaw tenant', true)
  const base = Number(process.env.OPENCLAW_BASE_PORT ?? 19789)
  const stride = Number(process.env.OPENCLAW_PORT_STRIDE ?? 1000)
  if (!Number.isInteger(base) || base < 1024 || !Number.isInteger(stride) || stride < 120 || base + 9 * stride + 110 > 65535) throw new OpenClawRunError('Invalid OpenClaw port allocation', true)
  return `ws://127.0.0.1:${base + (tenant - 1) * stride}`
}
/** Explicit opt-in per tenant; experimental transports never affect other users. */
export function openClawBrowserProfile(tenant:number):'tenant'|'extension-test'{
  if(!Number.isInteger(tenant)||tenant<1||tenant>10)throw new OpenClawRunError('Invalid OpenClaw tenant',true)
  let profiles:unknown
  try{profiles=JSON.parse(process.env.OPENCLAW_BROWSER_PROFILES??'{}')}catch{throw new OpenClawRunError('Invalid OpenClaw browser profile map',true)}
  if(!profiles||typeof profiles!=='object'||Array.isArray(profiles)||Object.entries(profiles).some(([key,value])=>!/^([1-9]|10)$/.test(key)||!['tenant','extension-test'].includes(value as string)))throw new OpenClawRunError('Invalid OpenClaw browser profile map',true)
  return (profiles as Record<string,'tenant'|'extension-test'>)[String(tenant)]??'tenant'
}
function assertLoopback(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password) throw new OpenClawRunError('OpenClaw must use a loopback WebSocket', true)
}
const scopes = ['operator.read', 'operator.write']
function deviceParams(identity: Identity, token: string, nonce: string, signedAt: number) {
  const raw = createPublicKey(identity.publicKeyPem).export({ format: 'der', type: 'spki' }).subarray(-32)
  const id = createHash('sha256').update(raw).digest('hex')
  const payload = ['v3', id, 'gateway-client', 'backend', 'operator', scopes.join(','), String(signedAt), token, nonce, process.platform.toLowerCase(), ''].join('|')
  return { id, publicKey: raw.toString('base64url'), signature: sign(null, Buffer.from(payload), identity.privateKeyPem).toString('base64url'), signedAt, nonce }
}
class Connection {
  private socket?: WebSocket
  private connecting?: Promise<void>
  private pending = new Map<string, { resolve: (payload: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  constructor(private url: string, private token: string, private identity: Identity | undefined, private timeout: number, private onEvent: (event: string, payload: Record<string, unknown>) => void) { assertLoopback(url) }
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting
    this.connecting = new Promise<void>((resolve, reject) => {
      let authenticated = false
      const ws = this.socket = new WebSocket(this.url, { maxPayload: 2 * 1024 * 1024 })
      const timer = setTimeout(() => { reject(new Error('OpenClaw handshake timed out')); ws.terminate() }, this.timeout)
      ws.on('message', (bytes) => {
        let frame: unknown
        try { frame = JSON.parse(bytes.toString()) } catch { return }
        if (isGatewayResponseFrame(frame)) {
          const pending = this.pending.get(frame.id)
          if (!pending) return
          clearTimeout(pending.timer); this.pending.delete(frame.id)
          if (frame.ok) pending.resolve(frame.payload)
          else pending.reject(new Error(`OpenClaw RPC rejected: ${frame.error?.code ?? 'unknown'}`))
        } else if (isGatewayEventFrame(frame)) {
          const payload = record(frame.payload)
          if (frame.event === 'connect.challenge' && !authenticated) {
            if (typeof payload.nonce !== 'string' || typeof payload.ts !== 'number') { reject(new Error('Invalid OpenClaw challenge')); ws.terminate(); return }
            const params = {
              minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION,
              client: { id: 'gateway-client', version: 'huntly-m3', platform: process.platform, mode: 'backend' },
              caps: ['tool-events'], role: 'operator', scopes, auth: { token: this.token },
              ...(this.identity ? { device: deviceParams(this.identity, this.token, payload.nonce, payload.ts) } : {}),
            }
            if (!validateConnectParams(params)) { reject(new Error('Invalid OpenClaw connect parameters')); ws.terminate(); return }
            authenticated = true
            void this.send('connect', params).then((hello) => {
              clearTimeout(timer)
              if (record(hello).type !== 'hello-ok' || record(hello).protocol !== PROTOCOL_VERSION) { reject(new Error('OpenClaw protocol mismatch')); ws.terminate(); return }
              resolve()
            }, (error: Error) => { clearTimeout(timer); reject(error); ws.terminate() })
          } else if (authenticated) this.onEvent(frame.event, payload)
        }
      })
      ws.on('error', () => { clearTimeout(timer); reject(new Error('OpenClaw gateway connection failed')) })
      ws.on('close', () => {
        clearTimeout(timer); this.connecting = undefined
        const error = new Error('OpenClaw gateway disconnected')
        reject(error)
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
        this.pending.clear()
      })
    })
    return this.connecting
  }
  private send(method: string, params: unknown, timeout = this.timeout): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN) { reject(new Error('OpenClaw socket is not open')); return }
      const id = randomUUID()
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`OpenClaw ${method} timed out`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ type: 'req', id, method, params }), (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error('OpenClaw send failed')) }
      })
    })
  }
  async rpc(method: string, params: unknown, timeout?: number): Promise<unknown> { await this.connect(); return this.send(method, params, timeout) }
  close() { this.socket?.terminate() }
}

export class OpenClawClient {
  private connections = new Map<number, Promise<Connection>>()
  private runs = new Map<string, Run>()
  private attempts = new Map<string, Promise<{ runId: string }>>()
  constructor(private options: OpenClawClientOptions = {}) {}
  private connection(tenant: number): Promise<Connection> {
    openClawGatewayUrl(tenant)
    const existing = this.connections.get(tenant)
    if (existing) return existing
    const pending = (async () => {
      const tokens = process.env.OPENCLAW_GATEWAY_TOKENS ? record(JSON.parse(process.env.OPENCLAW_GATEWAY_TOKENS)) : {}
      const token = await (this.options.tokenForTenant?.(tenant) ?? process.env[`OPENCLAW_GATEWAY_TOKEN_${tenant}`] ?? tokens[String(tenant)])
      if (typeof token !== 'string' || !token) throw new OpenClawRunError(`Missing OpenClaw gateway token for tenant ${tenant}`, true)
      let identity = await this.options.identityForTenant?.(tenant)
      const identityFile = process.env[`OPENCLAW_GATEWAY_DEVICE_FILE_${tenant}`]
      if (!identity && identityFile) identity = JSON.parse(await readFile(identityFile, 'utf8')) as Identity
      return new Connection(this.options.urlForTenant?.(tenant) ?? openClawGatewayUrl(tenant), token, identity, this.options.requestTimeoutMs ?? 10_000, (_event, payload) => {
        if (typeof payload.runId !== 'string') return
        const run = this.runs.get(payload.runId)
        if (!run || run.tenant !== tenant) return
        const data = record(payload.data)
        const event: OpenClawEvent = { runId: run.id, stream: typeof payload.stream === 'string' ? payload.stream : _event, data, seq: typeof payload.seq === 'number' ? payload.seq : undefined, ts: typeof payload.ts === 'number' ? payload.ts : undefined }
        if (event.stream === 'assistant') {
          if (typeof data.text === 'string') run.text = data.text
          else if (typeof data.delta === 'string') run.text += data.delta
        }
        for (const listener of run.listeners) { try { listener(event) } catch { /* Consumers cannot interrupt the watchdog. */ } }
      })
    })()
    this.connections.set(tenant, pending)
    void pending.catch(() => this.connections.delete(tenant))
    return pending
  }
  startRun(tenant: number, options: StartRunOptions): Promise<{ runId: string }> {
    openClawGatewayUrl(tenant)
    if (!options.attemptId || !options.prompt.trim()) return Promise.reject(new OpenClawRunError('Attempt id and prompt are required', true))
    const key = `${tenant}:${options.attemptId}`
    const existing = this.attempts.get(key)
    if (existing) return existing
    const pending = this.start(tenant, options)
    this.attempts.set(key, pending)
    return pending
  }
  private async start(tenant: number, options: StartRunOptions): Promise<{ runId: string }> {
    const deadline = Math.min(options.deadlineAt ?? Infinity, Date.now() + (options.timeoutMs ?? 180_000))
    if (deadline <= Date.now()) throw new OpenClawRunError('OpenClaw run deadline already expired', true)
    const files = options.files ?? []
    for (const file of files) if (!file.startsWith(`/home/huntly-u${tenant}/`) || file.includes('/../') || file.includes('\n')) throw new OpenClawRunError('Run files must be staged inside the tenant home', true)
    let resolve!: (result: RunResult) => void
    const done = new Promise<RunResult>((r) => { resolve = r })
    const run: Run = { id: options.attemptId, tenant, sessionKey: `agent:main:huntly-apply-${options.attemptId}`, deadline, text: '', childRuns: new Set(), listeners: new Set(options.onEvent ? [options.onEvent] : []), done, resolve }
    this.runs.set(run.id, run)
    run.timer = setTimeout(() => { void this.stop(run, 'timeout') }, Math.max(1, deadline - Date.now()))
    const params = { message: options.prompt + (files.length ? `\nFiles already staged on this tenant:\n${files.join('\n')}` : ''), sessionKey: run.sessionKey, idempotencyKey: options.attemptId, timeout: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)), deliver: false }
    if (!validateAgentParams(params)) throw new OpenClawRunError('Invalid OpenClaw agent parameters', true)
    try {
      const connection = await this.connection(tenant)
      const response = record(await connection.rpc('agent', params, Math.min(this.options.requestTimeoutMs ?? 10_000, Math.max(1, deadline - Date.now()))))
      if (typeof response.runId !== 'string') throw new Error('OpenClaw did not return a run id')
      if (run.id !== response.runId) { this.runs.delete(run.id); run.id = response.runId; this.runs.set(run.id, run) }
      void this.monitor(run)
      return { runId: run.id }
    } catch (error) {
      if (error instanceof OpenClawRunError && error.quiescent) {
        this.finish(run, { runId: run.id, status: 'error', text: '', cancelConfirmed: true, error: error.message })
        throw error
      }
      await this.stop(run, 'error')
      throw new OpenClawRunError('OpenClaw start failed; no automatic replay is safe', run.result?.cancelConfirmed === true, run.id)
    }
  }
  private finish(run: Run, result: RunResult) { if (run.result) return; clearTimeout(run.timer); run.result = result; run.resolve(result) }
  private terminal(payload: Record<string, unknown>): boolean {
    return ['ok', 'error', 'cancelled', 'aborted'].includes(String(payload.status)) && typeof payload.endedAt === 'number'
  }
  private async monitor(run: Run): Promise<void> {
    while (!run.result && !run.stopping) {
      try {
        const remaining = Math.max(1, run.deadline - Date.now())
        const params = { runId: run.id, timeoutMs: Math.min(10_000, remaining) }
        if (!validateAgentWaitParams(params)) throw new Error('Invalid wait parameters')
        const payload = record(await (await this.connection(run.tenant)).rpc('agent.wait', params, params.timeoutMs + 1_000))
        if (run.stopping || run.result) return
        if (this.terminal(payload)) {
          const reply = record(payload.terminalReply)
          const childrenStopped = await this.stopChildRuns(run)
          if (run.stopping || run.result) return
          if (!childrenStopped) { this.finish(run, { runId: run.id, status: 'error', text: run.text, cancelConfirmed: false, error: 'OpenClaw nudge cancellation unconfirmed' }); return }
          this.finish(run, { runId: run.id, status: payload.status === 'ok' ? 'ok' : payload.status === 'error' ? 'error' : 'cancelled', text: typeof reply.text === 'string' ? reply.text : run.text, error: typeof payload.error === 'string' ? payload.error : undefined, cancelConfirmed: true })
          return
        }
        if (Date.now() >= run.deadline) { await this.stop(run, 'timeout'); return }
        await new Promise((resolve) => setTimeout(resolve, 25))
      } catch { await this.stop(run, 'error'); return }
    }
  }
  private async stopChildRuns(run: Run): Promise<boolean> {
    const confirmations = await Promise.all([...run.childRuns].map(async (runId) => {
      try {
        const connection = await this.connection(run.tenant)
        await connection.rpc('chat.abort', { sessionKey: run.sessionKey, runId }, this.options.cancelTimeoutMs ?? 10_000)
        const result = record(await connection.rpc('agent.wait', { runId, timeoutMs: this.options.cancelTimeoutMs ?? 10_000 }, (this.options.cancelTimeoutMs ?? 10_000) + 1000))
        return this.terminal(result)
      } catch { return false }
    }))
    return confirmations.every(Boolean)
  }
  private stop(run: Run, status: 'timeout' | 'cancelled' | 'error'): Promise<void> {
    if (run.result) return Promise.resolve()
    if (run.stopping) return run.stopping
    run.stopping = (async () => {
      let cancelConfirmed = false
      try {
        const connection = await this.connection(run.tenant)
        const params = { sessionKey: run.sessionKey, runId: run.id }
        if (!validateChatAbortParams(params)) throw new Error('Invalid abort parameters')
        await connection.rpc('chat.abort', params, this.options.cancelTimeoutMs ?? 10_000)
        const payload = record(await connection.rpc('agent.wait', { runId: run.id, timeoutMs: this.options.cancelTimeoutMs ?? 10_000 }, (this.options.cancelTimeoutMs ?? 10_000) + 1000))
        cancelConfirmed = this.terminal(payload)
        const childrenStopped = await this.stopChildRuns(run)
        cancelConfirmed = cancelConfirmed && childrenStopped
      } catch { /* An acknowledged abort is not proof the browser tools stopped. */ }
      this.finish(run, { runId: run.id, status, text: run.text, cancelConfirmed, error: status === 'timeout' ? 'OpenClaw hard deadline exceeded' : status === 'error' ? 'OpenClaw transport or run failure' : undefined })
    })()
    return run.stopping
  }
  async waitForRun(runId: string, { timeoutMs }: { timeoutMs: number }): Promise<RunResult> {
    const run = this.requireRun(runId)
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new OpenClawRunError('Invalid wait timeout', false, runId)
    const timer = setTimeout(() => { void this.stop(run, 'timeout') }, timeoutMs)
    try { return await run.done } finally { clearTimeout(timer) }
  }
  streamEvents(runId: string, callback: (event: OpenClawEvent) => void): () => void { const run = this.requireRun(runId); run.listeners.add(callback); return () => { run.listeners.delete(callback) } }
  async cancelRun(runId: string): Promise<void> {
    const run = this.requireRun(runId)
    await this.stop(run, 'cancelled')
    if (!run.result?.cancelConfirmed) throw new OpenClawRunError('OpenClaw cancellation is unconfirmed; do not start a fallback driver', false, runId)
  }
  async nudgeRun(runId: string, message: string): Promise<void> {
    const run = this.requireRun(runId)
    if (run.result || run.stopping || Date.now() >= run.deadline) throw new OpenClawRunError('OpenClaw run is no longer active', Boolean(run.result?.cancelConfirmed), runId)
    if (run.childRuns.size >= 8) throw new OpenClawRunError('This attempt has reached its nudge limit', false, runId)
    const nudgeId = `${runId}:nudge:${randomUUID()}`
    const params = { sessionKey: run.sessionKey, message: message.trim(), queueMode: 'steer', idempotencyKey: nudgeId, deliver: false, timeoutMs: Math.max(1, run.deadline - Date.now()) }
    if (!params.message || params.message.length > 2000 || !validateChatSendParams(params)) throw new OpenClawRunError('Invalid nudge', false, runId)
    // chat.send creates its own run even when it injects into the primary run.
    // Keep it under the primary deadline, including acceptance-loss races.
    run.childRuns.add(nudgeId)
    const response = record(await (await this.connection(run.tenant)).rpc('chat.send', params))
    if (typeof response.runId === 'string') run.childRuns.add(response.runId)
  }
  private requireRun(runId: string) { const run = this.runs.get(runId); if (!run) throw new OpenClawRunError('Unknown OpenClaw run', false, runId); return run }
  async close(): Promise<void> { for (const run of this.runs.values()) if (!run.result) await this.stop(run, 'cancelled'); for (const connection of this.connections.values()) (await connection.catch(() => undefined))?.close() }
}
const defaultClient = new OpenClawClient()
export const startRun = defaultClient.startRun.bind(defaultClient)
export const waitForRun = defaultClient.waitForRun.bind(defaultClient)
export const streamEvents = defaultClient.streamEvents.bind(defaultClient)
export const cancelRun = defaultClient.cancelRun.bind(defaultClient)
export const nudgeRun = defaultClient.nudgeRun.bind(defaultClient)
