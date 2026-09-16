import assert from 'node:assert/strict'
import { it } from 'node:test'
import { anthropicHistory } from './tool-client.js'
import { modelFor } from './gateway.js'

it('converts tool calls and adjacent results without losing call identities', () => {
  const result = anthropicHistory([
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'act' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'a', function: { name: 'fill', arguments: '{"value":"Ada"}' } },
      { id: 'b', function: { name: 'observe', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
    { role: 'tool', tool_call_id: 'b', content: 'form' },
  ])
  assert.equal(result.system, 'rules')
  assert.equal(result.messages.length, 3)
  assert.deepEqual(result.messages[1]?.content, [
    { type: 'tool_use', id: 'a', name: 'fill', input: { value: 'Ada' } },
    { type: 'tool_use', id: 'b', name: 'observe', input: {} },
  ])
  assert.deepEqual(result.messages[2]?.content, [
    { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
    { type: 'tool_result', tool_use_id: 'b', content: 'form' },
  ])
})
it('converts inline screenshot bytes without fetching remote URLs', () => {
  const result = anthropicHistory([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }])
  assert.deepEqual(result.messages[0]?.content, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } }])
  assert.throws(() => anthropicHistory([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://localhost/private' } }] }]), /Unsupported/)
})
it('rejects tool results without call ids', () => {
  assert.throws(() => anthropicHistory([{ role: 'tool', content: 'ok' }]), /missing call id/)
})
it('does not route the answer resolver to retired Muse', () => {
  assert.doesNotMatch(modelFor('map-field'), /muse/i)
})
