import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deepseekBody, deepseekCompletion, deepseekFailure, deepseekMessages, deepseekUsage } from './deepseek.js'
import { ModelServiceUnavailableError } from './errors.js'

test('DeepSeek apply calls use V4.1 Flash with thinking, never OpenRouter extras', () => {
  const body = deepseekBody({
    userId: null,
    messages: [{ role: 'user', content: 'fixture' }],
    model: 'deepseek/deepseek-flash',
    effort: 'high',
  })
  assert.equal(body.model, 'deepseek-flash')
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.provider, undefined)
  assert.equal(body.reasoning, undefined)
})

test('follow-up tool turns send DeepSeek reasoning_content, never OpenRouter reasoning_details', () => {
  const messages = deepseekMessages([{
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: 'fixture', arguments: '{}' } }],
    reasoning_details: [{ type: 'reasoning_content', data: 'scratch' }],
  }])
  assert.equal((messages[0] as { reasoning_content?: string }).reasoning_content, 'scratch')
  assert.equal((messages[0] as { reasoning_details?: unknown }).reasoning_details, undefined)
})

test('cheap classification disables DeepSeek thinking', () => {
  const body = deepseekBody({
    userId: null,
    messages: [{ role: 'user', content: 'fixture' }],
    think: false,
    model: 'deepseek-flash',
  })
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.equal(body.reasoning_effort, undefined)
})

test('quota and authentication failures stay applicant-safe', () => {
  assert.equal((deepseekFailure(402) as ModelServiceUnavailableError).reason, 'provider_quota')
  assert.equal((deepseekFailure(401) as ModelServiceUnavailableError).reason, 'provider_auth')
  assert.doesNotMatch(deepseekFailure(400, 'sk-secret-echo').message, /sk-secret-echo/)
})

test('cache-hit tokens meter from the DeepSeek usage fields', () => {
  assert.deepEqual(deepseekUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40 }), {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 40,
  })
})

test('auth failure records safe metadata and does not retry', async () => {
  let requests = 0
  const recorded: unknown[] = []
  await assert.rejects(
    deepseekCompletion({ userId: null, messages: [{ role: 'user', content: 'synthetic' }] }, {
      apiKey: 'fixture-key',
      assertBudget: async () => undefined,
      record: async (row) => { recorded.push(row) },
      fetch: async () => {
        requests += 1
        return new Response(JSON.stringify({ error: { message: 'invalid api-key' } }), { status: 401 })
      },
    }),
    (error) => error instanceof ModelServiceUnavailableError && error.reason === 'provider_auth',
  )
  assert.equal(requests, 1)
  assert.equal((recorded[0] as { error: string }).error, 'provider_auth')
})
