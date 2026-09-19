import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decidePilotTerminal, filterPilotUnresolved, pageHasVerificationGate } from './pilot-outcome.js'
import type { PilotElement } from './pilot-page.js'

function element(partial: Partial<PilotElement> & Pick<PilotElement, 'label' | 'role'>): PilotElement {
  return {
    id: partial.id ?? 'e1',
    required: partial.required ?? true,
    value: partial.value ?? '',
    filled: partial.filled ?? false,
    options: partial.options ?? [],
    enabled: true,
    ...partial,
  }
}

test('Mercor filled radios are not leftover and map to can_submit', () => {
  const leftover = filterPilotUnresolved([
    element({ label: 'Are you a Student or New Grad?', role: 'radio', value: 'No', filled: true }),
    element({ label: 'If yes, when is your earliest start date?', role: 'radio', value: 'Immediately/next few months, full-time', filled: true }),
  ])
  assert.deepEqual(leftover, [])
  const terminal = decidePilotTerminal({ leftover, confirmed: false, verificationPending: false, looksLikeForm: true, filledCount: 6 })
  assert.equal(terminal.kind, 'can_submit')
  assert.equal(terminal.canSubmit, true)
  assert.equal(terminal.submitted, false)
})

test('student No drops the conditional start-date leftover', () => {
  const leftover = filterPilotUnresolved([
    element({ label: 'Are you a Student or New Grad?', role: 'radio', value: 'No', filled: true }),
    element({ label: 'If yes, when is your earliest start date?', role: 'radio', filled: false }),
  ])
  assert.equal(leftover.length, 0)
})

test('filled form with a human-check code is verification, not can_submit', () => {
  const leftover = filterPilotUnresolved([
    element({ label: 'First Name', role: 'textbox', value: 'Azhar', filled: true }),
  ])
  assert.equal(leftover.length, 0)
  const terminal = decidePilotTerminal({
    leftover,
    confirmed: false,
    verificationPending: true,
    looksLikeForm: true,
    filledCount: 15,
  })
  assert.equal(terminal.kind, 'verification')
  assert.equal(terminal.canSubmit, false)
})

test('Flexport verification gate is not a submitted application', () => {
  const text = 'A verification code was sent to mywritingfrenzy@gmail.com. To submit your application, enter the 8-character code to confirm you\'re a human. Security code'
  assert.equal(pageHasVerificationGate(text), true)
  const terminal = decidePilotTerminal({
    leftover: [],
    confirmed: false,
    verificationPending: true,
    looksLikeForm: true,
    filledCount: 8,
  })
  assert.equal(terminal.kind, 'verification')
  assert.equal(terminal.submitted, false)
  assert.equal(terminal.canSubmit, false)
  assert.equal(terminal.unresolved[0]?.why, 'login_required')
})

test('empty required radios do not block submit; the page error after click is the source of truth', () => {
  const leftover = filterPilotUnresolved([
    element({ label: 'Do you now, or in the future require sponsorship?', role: 'radio', filled: false }),
  ])
  assert.equal(leftover.length, 1)
  const terminal = decidePilotTerminal({ leftover, confirmed: false, verificationPending: false, looksLikeForm: true, filledCount: 8 })
  assert.equal(terminal.kind, 'can_submit')
  assert.equal(terminal.canSubmit, true)
})

test('confirmed thank-you maps to submitted', () => {
  const terminal = decidePilotTerminal({ leftover: [], confirmed: true, verificationPending: false, looksLikeForm: false, filledCount: 0 })
  assert.equal(terminal.kind, 'submitted')
  assert.equal(terminal.submitted, true)
})
