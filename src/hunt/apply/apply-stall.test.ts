import assert from 'node:assert/strict'
import { test } from 'node:test'
import { APPLY_STALL_MS, applyIsStalled, applyMadeProgress, leftoverSignature, stallMoveFromJev } from './apply-stall.js'

test('30 seconds without progress is a stall', () => {
  const started = 1_000
  assert.equal(applyIsStalled(started, started + 29_000), false)
  assert.equal(applyIsStalled(started, started + APPLY_STALL_MS), true)
  assert.equal(applyIsStalled(started, started + 31_000), true)
})

test('leftover signature ignores order and extra spaces', () => {
  assert.equal(leftoverSignature(['Location (City)', 'Submit']), leftoverSignature(['Submit', ' Location (City) ']))
})

test('progress is a changed leftover set or a newly filled field', () => {
  assert.equal(applyMadeProgress({ before: 'Location (City)', after: 'Location (City)', filledBefore: 3, filledAfter: 3 }), false)
  assert.equal(applyMadeProgress({ before: 'Location (City)', after: '', filledBefore: 3, filledAfter: 4 }), true)
  assert.equal(applyMadeProgress({ before: 'Location (City)|I agree', after: 'Location (City)', filledBefore: 2, filledAfter: 2 }), true)
})

test('Jev stall choice maps to a continue move; unknown becomes retry the same field', () => {
  assert.equal(stallMoveFromJev('retry_same'), 'retry_same')
  assert.equal(stallMoveFromJev('try_next'), 'try_next')
  assert.equal(stallMoveFromJev('wait'), 'wait')
  assert.equal(stallMoveFromJev('click'), 'click')
  assert.equal(stallMoveFromJev('submit'), 'submit')
  assert.equal(stallMoveFromJev('fail'), 'fail')
  assert.equal(stallMoveFromJev(null), 'retry_same')
  assert.equal(stallMoveFromJev('something-else'), 'retry_same')
})
