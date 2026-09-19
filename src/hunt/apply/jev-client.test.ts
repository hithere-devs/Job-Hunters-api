import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { jevRead, type JevAnswer } from './jev-client.js'

test('jevRead noul and choice extract typed answers', () => {
  const noul = { type: 'noul', noul: 0.91 } satisfies JevAnswer
  const choice = { type: 'choice', choice: 'fill', confidence: 0.8 } satisfies JevAnswer
  assert.equal(jevRead.noul(noul), 0.91)
  assert.equal(jevRead.choice(choice), 'fill')
  assert.equal(jevRead.noul(choice), 0)
  assert.equal(jevRead.choice(noul), null)
  assert.equal(jevRead.choice(undefined), null)
})

test('jevDecide posts System One payload and returns answers', async () => {
  const fetchMock = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      model: 'jev-latest',
      answers: {
        next_action: { type: 'choice', choice: 'fill', confidence: 0.9 },
        ready_to_submit: { type: 'noul', noul: 0.12 },
      },
      usage: { input_tokens: 80, output_tokens: 10 },
    }),
  }))
  const { jevDecide } = await import('./jev-client.js')
  const response = await jevDecide({
    apiKey: 'apikey_test',
    userId: null,
    state: { url: 'https://example.com' },
    questions: {
      next_action: { type: 'choice', instructions: 'next', criteria: { fill: 'fill' } },
      ready_to_submit: { type: 'noul', instructions: 'ready' },
    },
    fetch: fetchMock as unknown as typeof fetch,
    record: async () => undefined,
  })
  assert.equal(jevRead.choice(response.answers.next_action), 'fill')
  assert.equal(jevRead.noul(response.answers.ready_to_submit), 0.12)
  assert.equal(fetchMock.mock.calls.length, 1)
  const call = fetchMock.mock.calls[0]
  const init = (call?.arguments as unknown as [string, { body?: string }])[1]
  const body = JSON.parse(String(init.body))
  assert.equal(body.model, 'jev-latest')
  assert.equal(body.questions.next_action.type, 'choice')
})
