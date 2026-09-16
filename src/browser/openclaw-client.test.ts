import assert from 'node:assert/strict'
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto'
import { afterEach, test } from 'node:test'
import { WebSocketServer } from 'ws'
import { validateAgentParams, validateAgentWaitParams, validateChatAbortParams, validateChatSendParams, validateConnectParams } from '@openclaw/gateway-protocol'
import { OpenClawClient, OpenClawRunError, openClawGatewayUrl } from './openclaw-client.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function fixture(options: { complete?: boolean; noStop?: boolean; dropAgent?: boolean; waitUntilAbort?: boolean } = {}) {
  const requests: Array<{ id: string; method: string; params: Record<string, any> }> = []
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  let stopped = false
  const waiting: Array<() => void> = []
  server.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'test-nonce', ts: Date.now() } }))
    ws.on('message', (bytes) => {
      const request = JSON.parse(bytes.toString()); requests.push(request)
      const respond = (payload: unknown) => ws.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload }))
      if (request.method === 'connect') { assert.ok(validateConnectParams(request.params)); respond({ type: 'hello-ok', protocol: 4 }) }
      else if (request.method === 'agent') {
        assert.ok(validateAgentParams(request.params))
        if (options.dropAgent) { ws.terminate(); return }
        respond({ runId: request.params.idempotencyKey, status: 'accepted' })
        ws.send(JSON.stringify({ type: 'event', event: 'agent', payload: { runId: request.params.idempotencyKey, stream: 'assistant', data: { text: 'Form filled. Submit held.' }, seq: 1, ts: Date.now() } }))
      } else if (request.method === 'agent.wait') {
        assert.ok(validateAgentWaitParams(request.params))
        if (options.waitUntilAbort && !stopped) { waiting.push(() => respond({ runId: request.params.runId, status: 'error', endedAt: Date.now() })); return }
        respond(stopped || options.complete ? { runId: request.params.runId, status: stopped ? 'error' : 'ok', endedAt: Date.now(), terminalReply: { text: 'Ready for owner verification' } } : { runId: request.params.runId, status: 'timeout' })
      } else if (request.method === 'chat.abort') { assert.ok(validateChatAbortParams(request.params)); stopped = !options.noStop; waiting.splice(0).forEach(finish => finish()); respond({ ok: true, aborted: true, runIds: [request.params.runId] }) }
      else if (request.method === 'chat.send') { assert.ok(validateChatSendParams(request.params)); respond({ runId: request.params.idempotencyKey, status: 'accepted' }) }
    })
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const pair = generateKeyPairSync('ed25519')
  const identity = { privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKeyPem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString() }
  const client = new OpenClawClient({ urlForTenant: () => `ws://127.0.0.1:${address.port}`, tokenForTenant: (tenant) => `tenant-${tenant}-token`, identityForTenant: () => identity, requestTimeoutMs: 100, cancelTimeoutMs: 50 })
  cleanup.push(async () => { await client.close(); for (const ws of server.clients) ws.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())) })
  return { client, requests }
}
test('gateway allocations are non-overlapping and reject invalid tenants', () => {
  assert.equal(openClawGatewayUrl(1), 'ws://127.0.0.1:19789')
  assert.equal(openClawGatewayUrl(10), 'ws://127.0.0.1:28789')
  assert.throws(() => openClawGatewayUrl(11))
})
test('challenge handshake signs v3 device payload, starts once, streams, and waits for terminal proof', async () => {
  const { client, requests } = await fixture({ complete: true })
  const events: string[] = []
  const input = { attemptId: 'attempt-1', prompt: 'Fill test form', onEvent: (event: { stream: string }) => { events.push(event.stream) } }
  const [first, second] = await Promise.all([client.startRun(9, input), client.startRun(9, input)])
  assert.deepEqual(first, second)
  const result = await client.waitForRun(first.runId, { timeoutMs: 500 })
  assert.equal(result.status, 'ok'); assert.equal(result.cancelConfirmed, true)
  assert.equal(result.text, 'Ready for owner verification')
  assert.equal(requests.filter((request) => request.method === 'agent').length, 1)
  assert.deepEqual(events, ['assistant'])
  const params = requests[0]!.params
  assert.equal(params.auth.token, 'tenant-9-token')
  assert.equal(params.device.nonce, 'test-nonce')
  const payload = ['v3', params.device.id, 'gateway-client', 'backend', 'operator', params.scopes.join(','), String(params.device.signedAt), params.auth.token, 'test-nonce', process.platform.toLowerCase(), ''].join('|')
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(params.device.publicKey, 'base64url')]), format: 'der', type: 'spki' })
  assert.ok(verify(null, Buffer.from(payload), key, Buffer.from(params.device.signature, 'base64url')))
})
test('hard deadline cancels even when nobody calls waitForRun', async () => {
  const { client, requests } = await fixture()
  const { runId } = await client.startRun(9, { attemptId: 'deadline', prompt: 'Fill test form', timeoutMs: 60 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  const result = await client.waitForRun(runId, { timeoutMs: 500 })
  assert.equal(result.status, 'timeout'); assert.equal(result.cancelConfirmed, true)
  assert.equal(requests.filter((request) => request.method === 'chat.abort').length, 1)
})
test('wait timeout owns cancellation independently of the run deadline', async () => {
  const { client } = await fixture()
  const { runId } = await client.startRun(9, { attemptId: 'wait-deadline', prompt: 'Fill test form', timeoutMs: 10_000 })
  const result = await client.waitForRun(runId, { timeoutMs: 20 })
  assert.equal(result.status, 'timeout'); assert.equal(result.cancelConfirmed, true)
})
test('abort acknowledgement without terminal proof must not permit fallback', async () => {
  const { client } = await fixture({ noStop: true })
  const { runId } = await client.startRun(9, { attemptId: 'unconfirmed', prompt: 'Fill test form' })
  await assert.rejects(client.cancelRun(runId), (error: unknown) => error instanceof OpenClawRunError && !error.quiescent)
  const result = await client.waitForRun(runId, { timeoutMs: 100 })
  assert.equal(result.cancelConfirmed, false)
})
test('nudge uses the existing logical session with steer and is rejected after cancellation', async () => {
  const { client, requests } = await fixture()
  const { runId } = await client.startRun(9, { attemptId: 'nudge', prompt: 'Fill test form' })
  await client.nudgeRun(runId, 'Use the saved resume')
  const nudge = requests.find((request) => request.method === 'chat.send')!
  const start = requests.find((request) => request.method === 'agent')!
  assert.equal(nudge.params.sessionKey, start.params.sessionKey); assert.equal(nudge.params.queueMode, 'steer')
  await client.cancelRun(runId)
  assert.ok(requests.some((request) => request.method === 'chat.abort' && request.params.runId === nudge.params.idempotencyKey), 'the nudge side run must also be cancelled')
  await assert.rejects(client.nudgeRun(runId, 'Continue'))
})
test('ambiguous disconnect never replays the agent RPC automatically', async () => {
  const { client, requests } = await fixture({ dropAgent: true, noStop: true })
  const input = { attemptId: 'dropped', prompt: 'Fill test form' }
  await assert.rejects(client.startRun(9, input), (error: unknown) => error instanceof OpenClawRunError && !error.quiescent)
  await assert.rejects(client.startRun(9, input))
  assert.equal(requests.filter((request) => request.method === 'agent').length, 1)
})
test('rejects cross-tenant files and non-loopback targets', async () => {
  const { client } = await fixture()
  await assert.rejects(client.startRun(9, { attemptId: 'wrong-file', prompt: 'Fill', files: ['/home/huntly-u3/private.pdf'] }))
  const publicClient = new OpenClawClient({ tokenForTenant: () => 'token', urlForTenant: () => 'ws://example.com:19789', cancelTimeoutMs: 10 })
  await assert.rejects(publicClient.startRun(9, { attemptId: 'public-host', prompt: 'Fill' }))
  await publicClient.close()
})

test('timeout reason wins when an in-flight wait returns a terminal error during abort', async () => {
  const { client } = await fixture({ waitUntilAbort: true })
  const { runId } = await client.startRun(9, { attemptId: 'abort-race', prompt: 'Fill test form', timeoutMs: 10000 })
  const result = await client.waitForRun(runId, { timeoutMs: 20 })
  assert.equal(result.status, 'timeout'); assert.equal(result.cancelConfirmed, true)
})
