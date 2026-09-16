import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nudgeApplication } from './nudges.js'
import { createNudgeCommand, nudgeMessageSchema } from '../../hunt/apply/openclaw-nudges.js'
const target = { attemptId: '8c6f31eb-d193-43cd-aa64-2515c09f260c', userId: 'owner', active: true, completed: false, submitting: false, tier: 'openclaw', lifecycle: 'started' }
test('nudge requires owner and targets the latest active OpenClaw attempt', async () => {
  let sent = ''
  const result = await nudgeApplication('owner', 'app', 'Use the uploaded resume', { target: async () => target, publish: async (attemptId) => { sent = attemptId; return 1 } })
  assert.equal(result.accepted, true); assert.equal(sent, target.attemptId)
  await assert.rejects(nudgeApplication('other', 'app', 'Continue', { target: async () => target, publish: async () => { throw new Error('must not publish') } }), /Application not found/)
})
test('completed, final-submit, inactive, legacy, and terminal OpenClaw attempts reject nudges', async () => {
  for (const patch of [{ completed: true }, { submitting: true }, { active: false }, { tier: 'legacy_fallback' }, { lifecycle: 'ok' }, { lifecycle: 'timeout' }]) {
    await assert.rejects(nudgeApplication('owner', 'app', 'Continue', { target: async () => ({ ...target, ...patch }), publish: async () => { throw new Error('must not publish') } }), /not currently filling/)
  }
})
test('no subscriber means no accepted nudge', async () => {
  await assert.rejects(nudgeApplication('owner', 'app', 'Continue', { target: async () => target, publish: async () => 0 }), /no longer listening/)
})
test('nudge validation rejects credentials, codes, long or empty input', () => {
  for (const value of ['', 'x'.repeat(2001), 'My password is hello', 'OTP 123456', 'verification code 123456', 'Bearer secret', 'api_key=secret']) assert.equal(nudgeMessageSchema.safeParse(value).success, false)
  const command = createNudgeCommand(target.attemptId, 'Use my saved city')
  assert.equal(command.message, 'Use my saved city'); assert.ok(command.expiresAt > Date.now()); assert.equal(command.attemptId, target.attemptId)
})
