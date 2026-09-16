import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod/v4'
import { env } from '../config/env.js'
import { ModelServiceUnavailableError } from './errors.js'
import type { CallOptions } from './gateway.js'
import { assertWithinBudget, recordUsage, type Purpose, type RawUsage } from './meter.js'
import { openRouterMessages, parseStructuredJson, structuredJsonInstructions } from './openrouter.js'
import type { ToolCall, ToolMessage, ToolResult } from './tool-client.js'

const execFileAsync = promisify(execFile)
let cachedToken: { value: string; expiresAt: number } | undefined

interface VertexResponse {
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: ToolCall[] } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string; status?: string }
}

async function metadataToken(fetchRequest: typeof fetch): Promise<{ value: string; expiresAt: number } | null> {
  try {
    const response = await fetchRequest('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(1_500),
    })
    if (!response.ok) return null
    const body = await response.json() as { access_token?: string; expires_in?: number }
    if (!body.access_token) return null
    return { value: body.access_token, expiresAt: Date.now() + Math.max(60, body.expires_in ?? 3600) * 1000 }
  } catch { return null }
}

async function gcloudToken(): Promise<{ value: string; expiresAt: number } | null> {
  try {
    const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token'], { timeout: 15_000, maxBuffer: 64 * 1024 })
    const value = stdout.trim()
    return value ? { value, expiresAt: Date.now() + 50 * 60_000 } : null
  } catch { return null }
}

export async function vertexAccessToken(fetchRequest: typeof fetch = fetch): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value
  cachedToken = await metadataToken(fetchRequest) ?? await gcloudToken() ?? undefined
  if (!cachedToken) throw new ModelServiceUnavailableError('provider_auth')
  return cachedToken.value
}

export interface VertexOptions {
  userId: string | null; purpose?: Purpose; model?: string; messages: ToolMessage[]; tools?: unknown[]
  maxTokens?: number; temperature?: number; signal?: AbortSignal; responseFormat?: unknown
}

export async function vertexCompletion(options: VertexOptions, dependencies: {
  fetch?: typeof fetch; token?: () => Promise<string>; assertBudget?: typeof assertWithinBudget; record?: typeof recordUsage; project?: string; location?: string
} = {}): Promise<ToolResult> {
  const project = dependencies.project ?? env.GOOGLE_CLOUD_PROJECT
  if (!project) throw new ModelServiceUnavailableError('provider_auth')
  await (dependencies.assertBudget ?? assertWithinBudget)(options.userId)
  const fetchRequest = dependencies.fetch ?? fetch
  const token = await (dependencies.token ?? (() => vertexAccessToken(fetchRequest)))()
  const location = dependencies.location ?? env.GOOGLE_CLOUD_LOCATION
  const model = (options.model ?? env.MODEL_DEFAULT).replace(/^google-vertex\//, 'google/').replace(/^gemini-/, 'google/gemini-')
  const url = `https://aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/endpoints/openapi/chat/completions`
  const body = {
    model, messages: openRouterMessages(options.messages), max_tokens: options.maxTokens ?? env.APPLY_AGENT_MAX_TOKENS,
    ...(options.tools?.length ? { tools: options.tools } : {}),
    ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  }
  const purpose = options.purpose ?? 'apply-agent', startedAt = Date.now()
  let usage: RawUsage | undefined
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000)
    const response = await fetchRequest(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
    const data = await response.json() as VertexResponse
    usage = { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 }
    if (!response.ok || data.error) {
      if (response.status === 401 || response.status === 403) throw new ModelServiceUnavailableError('provider_auth')
      if (response.status === 429) throw new ModelServiceUnavailableError('provider_quota')
      throw Object.assign(new Error(`Vertex AI request rejected (HTTP ${response.status}).`), { status: response.status })
    }
    const choice = data.choices?.[0]
    if (!choice?.message || (!choice.message.content && !choice.message.tool_calls?.length)) throw new Error('Vertex AI returned no text or tool call.')
    const result: ToolResult = { content: choice.message.content ?? null, toolCalls: choice.message.tool_calls ?? [], finishReason: choice.finish_reason ?? 'unknown' }
    await (dependencies.record ?? recordUsage)({ userId: options.userId, purpose, model, usage, durationMs: Date.now() - startedAt, ok: true })
    return result
  } catch (error) {
    await (dependencies.record ?? recordUsage)({ userId: options.userId, purpose, model, usage, durationMs: Date.now() - startedAt, ok: false, error: error instanceof ModelServiceUnavailableError ? error.reason : error instanceof Error ? error.name : 'model_request_failed' })
    throw error
  }
}

export async function vertexStructured<T extends z.ZodType>(schema: T, options: CallOptions): Promise<z.infer<T>> {
  const result = await vertexCompletion({ ...options, messages: [{ role: 'system', content: structuredJsonInstructions(schema, options) }, { role: 'user', content: options.prompt }], responseFormat: { type: 'json_object' } })
  return parseStructuredJson(schema, result.content)
}

export async function vertexText(options: CallOptions): Promise<string> {
  const result = await vertexCompletion({ ...options, messages: [...(options.system ? [{ role: 'system' as const, content: options.system }] : []), { role: 'user', content: options.prompt }] })
  return result.content?.trim() ?? ''
}
