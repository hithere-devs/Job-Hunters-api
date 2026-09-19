import { z } from 'zod/v4'
import { env } from '../config/env.js'
import { assertWithinBudget, recordUsage, type Purpose, type RawUsage } from './meter.js'
import { ModelServiceUnavailableError, modelServiceFailure } from './errors.js'
import type { CallOptions } from './gateway.js'
import {
  openRouterMessages,
  parseStructuredJson,
  structuredJsonInstructions,
  type OpenRouterOptions,
} from './openrouter.js'
import type { ToolMessage, ToolResult } from './tool-client.js'

interface DeepSeekResponse {
  choices?: Array<{
    finish_reason?: string
    message?: {
      content?: string | null
      tool_calls?: ToolResult['toolCalls']
      reasoning_content?: string | null
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string; code?: string | number }
}

function apiModel(model?: string): string {
  return (model ?? env.MODEL_DEFAULT).replace(/^deepseek\//, '')
}

function reasoningEffort(options: OpenRouterOptions): 'low' | 'medium' | 'high' | 'max' | undefined {
  if (options.think === false) return undefined
  if (!options.effort || options.effort === 'low') return 'low'
  if (options.effort === 'medium') return 'medium'
  if (options.effort === 'high') return 'high'
  return 'max'
}

export function deepseekMessages(messages: ToolMessage[]): Array<Record<string, unknown>> {
  return openRouterMessages(messages).map((message) => {
    const { reasoning_details: details, ...rest } = message
    const row: Record<string, unknown> = { ...rest }
    if (message.role !== 'assistant' || !Array.isArray(details)) return row
    const reasoning = details
      .map((block) => {
        if (!block || typeof block !== 'object') return ''
        const item = block as { type?: unknown; data?: unknown; text?: unknown }
        if (typeof item.data === 'string') return item.data
        if (typeof item.text === 'string') return item.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
    if (reasoning) row.reasoning_content = reasoning
    return row
  })
}

export function deepseekBody(options: OpenRouterOptions): Record<string, unknown> {
  const thinking = options.think === false ? 'disabled' : 'enabled'
  const effort = reasoningEffort(options)
  return {
    model: apiModel(options.model),
    messages: deepseekMessages(options.messages),
    max_tokens: options.maxTokens ?? env.APPLY_AGENT_MAX_TOKENS,
    thinking: { type: thinking },
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(options.tools?.length ? { tools: options.tools } : {}),
    ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  }
}

export function deepseekUsage(usage: DeepSeekResponse['usage']): RawUsage {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    cache_read_input_tokens: usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0,
  }
}

export function deepseekFailure(status: number, message?: string): Error {
  if (status === 402) return new ModelServiceUnavailableError('provider_quota')
  if (status === 401 || status === 403) return new ModelServiceUnavailableError('provider_auth')
  const unavailable = modelServiceFailure(message ?? '')
  if (unavailable) return unavailable
  const error = new Error(`DeepSeek model request rejected (HTTP ${status}).`)
  Object.assign(error, { status })
  return error
}

export interface DeepSeekDependencies {
  apiKey?: string
  fetch?: typeof fetch
  assertBudget?: typeof assertWithinBudget
  record?: typeof recordUsage
}

export async function deepseekCompletion(options: OpenRouterOptions, dependencies: DeepSeekDependencies = {}): Promise<ToolResult> {
  const apiKey = dependencies.apiKey ?? env.DEEPSEEK_API_KEY
  const fetchRequest = dependencies.fetch ?? fetch
  const record = dependencies.record ?? recordUsage
  if (!apiKey) throw new ModelServiceUnavailableError('provider_auth')
  await (dependencies.assertBudget ?? assertWithinBudget)(options.userId)
  const body = deepseekBody(options)
  const model = String(body.model)
  const purpose = options.purpose ?? 'apply-agent'
  const startedAt = Date.now()
  let usage: RawUsage | undefined
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000)
    const response = await fetchRequest(`${env.DEEPSEEK_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const data = await response.json() as DeepSeekResponse
    usage = deepseekUsage(data.usage)
    if (!response.ok || data.error) throw deepseekFailure(response.status, data.error?.message)
    const choice = data.choices?.[0]
    if (!choice?.message || (!choice.message.content && !choice.message.tool_calls?.length)) {
      throw new Error('DeepSeek returned no text or tool call within the model token budget.')
    }
    const result: ToolResult = {
      content: choice.message.content ?? null,
      toolCalls: choice.message.tool_calls ?? [],
      finishReason: choice.finish_reason ?? 'unknown',
      ...(choice.message.reasoning_content
        ? { reasoningDetails: [{ type: 'reasoning_content', data: choice.message.reasoning_content }] }
        : {}),
    }
    for (const call of result.toolCalls) {
      if (typeof call.id !== 'string' || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') {
        throw new Error('DeepSeek returned an invalid tool call.')
      }
    }
    await record({ userId: options.userId, purpose, model, usage, durationMs: Date.now() - startedAt, ok: true })
    return result
  } catch (error) {
    await record({
      userId: options.userId,
      purpose,
      model,
      usage,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: error instanceof ModelServiceUnavailableError
        ? error.reason
        : error && typeof error === 'object' && 'status' in error
          ? `provider_http_${String(error.status)}`
          : error instanceof Error ? error.name : 'model_request_failed',
    })
    throw error
  }
}

export async function deepseekStructured<T extends z.ZodType>(schema: T, options: CallOptions): Promise<z.infer<T>> {
  const result = await deepseekCompletion({
    ...options,
    messages: [
      { role: 'system', content: structuredJsonInstructions(schema, options) },
      { role: 'user', content: options.prompt },
    ],
    responseFormat: { type: 'json_object' },
  })
  return parseStructuredJson(schema, result.content)
}

export async function deepseekText(options: CallOptions): Promise<string> {
  const result = await deepseekCompletion({
    ...options,
    messages: [
      ...(options.system ? [{ role: 'system' as const, content: options.system }] : []),
      { role: 'user', content: options.prompt },
    ],
  })
  return result.content?.trim() ?? ''
}
