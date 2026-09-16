import assert from 'node:assert/strict'
import test from 'node:test'
import { vertexCompletion } from './vertex.js'
import { ModelServiceUnavailableError } from './errors.js'

test('Vertex completion uses GCP bearer auth, records usage, and preserves tool calls', async () => {
  const recorded: unknown[] = []
  const result = await vertexCompletion({ userId: null, purpose: 'apply-agent', model: 'google/gemini-2.5-flash', messages: [{ role: 'user', content: 'fixture' }] }, {
    project: 'azhar-496213', location: 'global', token: async () => 'fixture-token', assertBudget: async () => {}, record: async value => { recorded.push(value) },
    fetch: async (url, init) => {
      assert.match(String(url), /projects\/azhar-496213\/locations\/global/)
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fixture-token')
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'fill', arguments: '{}' } }] } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }), { status: 200 })
    },
  })
  assert.equal(result.toolCalls[0]?.function.name, 'fill')
  assert.deepEqual((recorded[0] as { usage: unknown }).usage, { input_tokens: 4, output_tokens: 2 })
})

test('Vertex authentication failures are safe provider errors', async () => {
  await assert.rejects(vertexCompletion({ userId: null, messages: [{ role: 'user', content: 'fixture' }] }, {
    project: 'azhar-496213', location: 'global', token: async () => 'fixture-token', assertBudget: async () => {}, record: async () => {},
    fetch: async () => new Response(JSON.stringify({ error: { message: 'secret provider echo' } }), { status: 403 }),
  }), error => error instanceof ModelServiceUnavailableError && error.reason === 'provider_auth' && !error.message.includes('secret provider echo'))
})
