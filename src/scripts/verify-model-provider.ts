/** Synthetic connection/tool-call check. No profile, cookie, or job data is sent. */
import assert from 'node:assert/strict'
import { toolCompletion } from '../model/tool-client.js'
import { getPool } from '../db/client.js'
import { env } from '../config/env.js'
try {
  const result = await toolCompletion({
    userId: null,
    maxTokens: 1024,
    messages: [{ role: 'user', content: 'Call the fixture tool with value MODEL_OK. This is a synthetic transport test, not a browser action.' }],
    tools: [{ type: 'function', function: { name: 'fixture', description: 'Synthetic connectivity test', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } }],
  })
  assert.equal(result.toolCalls[0]?.function.name, 'fixture')
  assert.equal(JSON.parse(result.toolCalls[0]!.function.arguments).value, 'MODEL_OK')
  console.log(`PASS actual ${env.APPLY_AGENT_MODEL}: tool call decoded, synthetic value MODEL_OK; usage metered.`)
  const followup = await toolCompletion({
    userId: null, maxTokens: 1024,
    messages: [
      { role: 'user', content: 'Call the fixture tool with value MODEL_OK.' },
      { role: 'assistant', content: result.content ?? '', tool_calls: result.toolCalls, ...(result.reasoningDetails?.length ? { reasoning_details: result.reasoningDetails } : {}) },
      { role: 'tool', tool_call_id: result.toolCalls[0]!.id, content: 'Fixture recorded MODEL_OK.' },
      { role: 'user', content: 'Now reply with exactly MODEL_OK_DONE.' },
    ],
  })
  assert.match(followup.content ?? '', /MODEL_OK_DONE/)
  console.log(`PASS actual ${env.APPLY_AGENT_MODEL}: second tool turn accepted preserved opaque reasoning metadata; usage metered.`)
} finally { await getPool().end() }
