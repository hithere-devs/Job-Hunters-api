import { z } from 'zod/v4'
import { env } from '../config/env.js'
import { assertWithinBudget, recordUsage, type Purpose, type RawUsage } from './meter.js'
import { ModelServiceUnavailableError, modelServiceFailure } from './errors.js'
import type { CallOptions } from './gateway.js'
import type { ToolMessage, ToolResult, ToolCall } from './tool-client.js'

interface OpenRouterResponse {
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: ToolCall[]; reasoning_details?: unknown[] } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cost?: number }
  error?: { message?: string; code?: string | number }
}
export interface OpenRouterOptions {
  userId: string | null; purpose?: Purpose; model?: string; messages: ToolMessage[]; tools?: unknown[]
  maxTokens?: number; temperature?: number; signal?: AbortSignal; responseFormat?: unknown
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; think?: boolean
}
/** Preserve tool-call IDs and inline screenshot bytes. Never forward remote image URLs. */
export function openRouterMessages(messages: ToolMessage[]): ToolMessage[] {
  return messages.map(message => {
    if (message.role === 'tool' && !message.tool_call_id) throw new Error('Tool result missing call id')
    if (message.content !== null && typeof message.content !== 'string' && !Array.isArray(message.content)) throw new Error('Unsupported model message content')
    if (Array.isArray(message.content)) for (const block of message.content) {
      if (block?.type === 'text' && typeof block.text === 'string') continue
      if (block?.type === 'image_url' && typeof block.image_url?.url === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(block.image_url.url)) continue
      throw new Error('Unsupported model content block')
    }
    return { ...message }
  })
}
/** Gemini 3.5 reasoning cannot be disabled, including cheap classification calls. */
export function openRouterBody(options: OpenRouterOptions): Record<string, unknown> {
  return {
    model: options.model ?? env.MODEL_DEFAULT,
    messages: openRouterMessages(options.messages),
    max_tokens: options.maxTokens ?? env.APPLY_AGENT_MAX_TOKENS,
    reasoning: { effort: options.think === false || !options.effort ? 'low' : ['xhigh', 'max'].includes(options.effort) ? 'high' : options.effort },
    provider: { require_parameters: true },
    ...(options.tools?.length ? { tools: options.tools } : {}),
    ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  }
}
export function openRouterUsage(usage: OpenRouterResponse['usage']): RawUsage {
  return { input_tokens: usage?.prompt_tokens ?? 0, output_tokens: usage?.completion_tokens ?? 0, cache_read_input_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0, ...(typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? { cost_usd: usage.cost } : {}) }
}
export function openRouterFailure(status: number, message?: string): Error {
  if (status === 402) return new ModelServiceUnavailableError('provider_quota')
  if (status === 401 || status === 403) return new ModelServiceUnavailableError('provider_auth')
  const unavailable = modelServiceFailure(message ?? '')
  if (unavailable) return unavailable
  // Provider error payloads may quote prompts or credentials. Never persist them.
  const error = new Error(`OpenRouter model request rejected (HTTP ${status}).`)
  Object.assign(error, { status })
  return error
}
export interface OpenRouterDependencies {
  apiKey?: string
  fetch?: typeof fetch
  assertBudget?: typeof assertWithinBudget
  record?: typeof recordUsage
}
export async function openRouterCompletion(options: OpenRouterOptions, dependencies: OpenRouterDependencies = {}): Promise<ToolResult> {
  const apiKey = dependencies.apiKey ?? env.OPENROUTER_API_KEY
  const fetchRequest = dependencies.fetch ?? fetch
  const record = dependencies.record ?? recordUsage
  if (!apiKey) throw new ModelServiceUnavailableError('provider_auth')
  await (dependencies.assertBudget ?? assertWithinBudget)(options.userId)
  const body = openRouterBody(options), model = String(body.model), purpose = options.purpose ?? 'apply-agent', startedAt = Date.now()
  let usage: RawUsage | undefined
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000)
    const response = await fetchRequest(`${env.OPENROUTER_API_BASE}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    })
    const data = await response.json() as OpenRouterResponse
    usage = openRouterUsage(data.usage)
    if (!response.ok || data.error) throw openRouterFailure(response.status, data.error?.message)
    const choice = data.choices?.[0]
    if (!choice?.message || (!choice.message.content && !choice.message.tool_calls?.length)) throw new Error('OpenRouter returned no text or tool call within the model token budget.')
    const result: ToolResult = { content: choice.message.content ?? null, toolCalls: choice.message.tool_calls ?? [], finishReason: choice.finish_reason ?? 'unknown', ...(Array.isArray(choice.message.reasoning_details) ? { reasoningDetails: choice.message.reasoning_details } : {}) }
    for (const call of result.toolCalls) if (typeof call.id !== 'string' || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') throw new Error('OpenRouter returned an invalid tool call.')
    await record({ userId: options.userId, purpose, model, usage, durationMs: Date.now() - startedAt, ok: true })
    return result
  } catch (error) {
    await record({ userId: options.userId, purpose, model, usage, durationMs: Date.now() - startedAt, ok: false, error: error instanceof ModelServiceUnavailableError ? error.reason : error && typeof error === 'object' && 'status' in error ? `provider_http_${String(error.status)}` : error instanceof Error ? error.name : 'model_request_failed' })
    throw error
  }
}
export function structuredJsonInstructions<T extends z.ZodType>(schema: T, options: CallOptions): string {
  const contract = { type: 'object', properties: { result: z.toJSONSchema(schema, { io: 'output' }) }, required: ['result'], additionalProperties: false }
  return [options.system, 'Transport output: return one JSON object with a result property matching the following schema. This envelope is required. Do not include Markdown or prose outside JSON.', JSON.stringify(contract)].filter(Boolean).join('\n\n')
}
export async function openRouterStructured<T extends z.ZodType>(schema: T, options: CallOptions): Promise<z.infer<T>> {
  // Gemini currently rejects some complex response_schema constraints. JSON mode
  // plus the full schema instruction keeps output typed by our unchanged Zod check.
  const result = await openRouterCompletion({ ...options, messages: [{ role: 'system', content: structuredJsonInstructions(schema, options) }, { role: 'user', content: options.prompt }], responseFormat: { type: 'json_object' } })
  return parseStructuredJson(schema, result.content)
}
export function parseStructuredJson<T extends z.ZodType>(schema: T, content: string | null): z.infer<T> {
  if (!content) throw new Error('OpenRouter returned no structured answer.')
  let value: unknown
  try { value = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) } catch { throw new Error('OpenRouter returned invalid structured JSON.') }
  if (!value || typeof value !== 'object' || !('result' in value)) throw new Error('OpenRouter omitted the structured result envelope.')
  return schema.parse(value.result) as z.infer<T>
}
export async function openRouterText(options: CallOptions): Promise<string> {
  const result = await openRouterCompletion({ ...options, messages: [...(options.system ? [{ role: 'system' as const, content: options.system }] : []), { role: 'user', content: options.prompt }] })
  return result.content?.trim() ?? ''
}
