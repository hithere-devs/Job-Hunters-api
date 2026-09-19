import Anthropic from '@anthropic-ai/sdk'
import { openRouterCompletion } from './openrouter.js'
import { deepseekCompletion } from './deepseek.js'
import { vertexCompletion } from './vertex.js'
import { env } from '../config/env.js'
import { assertWithinBudget, recordUsage, type Purpose } from './meter.js'

/** Provider-neutral history retained by the legacy loop while OpenClaw is gated. */
export interface ToolMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: unknown
  tool_call_id?: string
  tool_calls?: unknown
  /** Provider-opaque thought signatures required to continue Gemini tool turns. */
  reasoning_details?: unknown[]
}
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ToolResult { content: string | null; toolCalls: ToolCall[]; finishReason: string; reasoningDetails?: unknown[] }

type Block = Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam
function contentBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) throw new Error('Unsupported model message content')
  return content.map((block): Block => {
    if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text }
    if (block.type === 'image_url' && typeof block.image_url?.url === 'string') {
      const image = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(block.image_url.url)
      if (image) return { type: 'image', source: { type: 'base64', media_type: image[1] as Anthropic.Base64ImageSource['media_type'], data: image[2]! } }
    }
    // Remote URLs are not fetched. Screenshots must be supplied as local bytes.
    throw new Error('Unsupported model content block')
  })
}

export function anthropicHistory(history: ToolMessage[]): { system: string; messages: Anthropic.MessageParam[] } {
  const system: string[] = []
  const messages: Anthropic.MessageParam[] = []
  for (const message of history) {
    if (message.role === 'system') {
      if (typeof message.content !== 'string') throw new Error('System prompt must be text')
      system.push(message.content)
      continue
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const content: Block[] = message.role === 'tool'
      ? [{ type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }]
      : contentBlocks(message.content)
    if (message.role === 'tool' && !message.tool_call_id) throw new Error('Tool result missing call id')
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls as ToolCall[]) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })
    }
    if (!content.length) continue
    // Anthropic requires tool results together in the immediately following user turn.
    const previous = messages.at(-1)
    if (previous?.role === role && Array.isArray(previous.content)) previous.content.push(...content)
    else messages.push({ role, content })
  }
  return { system: system.join('\n\n'), messages }
}

let client: Anthropic | undefined
export async function toolCompletion(params: { userId: string | null; messages: ToolMessage[]; tools?: unknown[]; maxTokens?: number; temperature?: number; purpose?: Purpose; model?: string; signal?: AbortSignal }): Promise<ToolResult> {
  if (env.MODEL_PROVIDER === 'openrouter') return openRouterCompletion({ ...params, model: params.model ?? env.APPLY_AGENT_MODEL })
  if (env.MODEL_PROVIDER === 'vertex') return vertexCompletion({ ...params, model: params.model ?? env.APPLY_AGENT_MODEL })
  if (env.MODEL_PROVIDER === 'deepseek') return deepseekCompletion({ ...params, model: params.model ?? env.APPLY_AGENT_MODEL })
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set')
  await assertWithinBudget(params.userId)
  const purpose = params.purpose ?? 'apply-agent'
  const model = params.model ?? env.APPLY_AGENT_MODEL
  const startedAt = Date.now()
  const history = anthropicHistory(params.messages)
  const tools: Anthropic.Tool[] = (params.tools ?? []).map((value) => {
    const tool = value as { type: string; function: { name: string; description?: string; parameters: Anthropic.Tool.InputSchema } }
    if (tool.type !== 'function' || !tool.function?.name) throw new Error('Unsupported model tool')
    return { name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }
  })
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 0, ...(env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID } } : {}) })
  try {
    const result = await client.messages.create({ model, max_tokens: params.maxTokens ?? env.APPLY_AGENT_MAX_TOKENS, ...history, ...(tools.length ? { tools } : {}), ...(params.temperature === undefined ? {} : { temperature: params.temperature }) }, { signal: params.signal })
    await recordUsage({ userId: params.userId, purpose, model, usage: result.usage, durationMs: Date.now() - startedAt, ok: true })
    return {
      content: result.content.filter((block): block is Anthropic.TextBlock => block.type === 'text').map((block) => block.text).join('') || null,
      toolCalls: result.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use').map((block) => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } })),
      finishReason: result.stop_reason ?? 'unknown',
    }
  } catch (error) {
    await recordUsage({ userId: params.userId, purpose, model, usage: undefined, durationMs: Date.now() - startedAt, ok: false, error: error instanceof Error ? error.name : 'model_request_failed' })
    throw error
  }
}
