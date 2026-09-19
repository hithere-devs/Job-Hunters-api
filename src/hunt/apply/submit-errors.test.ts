import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractPageErrors, fieldMatchingError, fieldsToRepairAfterSubmit } from './submit-errors.js'
import type { PilotElement } from './pilot-page.js'

function element(partial: Partial<PilotElement> & Pick<PilotElement, 'id' | 'label'>): PilotElement {
  return {
    role: 'radio',
    required: true,
    value: '',
    filled: false,
    options: ['Yes', 'No'],
    enabled: true,
    ...partial,
  }
}

test('extracts the visible required-field error, not the job description', () => {
  const body = [
    'Platform Engineer',
    'Do you now, or in the future require sponsorship?',
    'This field is required',
    'Submit application',
  ].join('\n')
  assert.match(extractPageErrors(body), /this field is required/i)
})

test('maps a sponsorship error to the sponsorship radios, not a Yes option leftover', () => {
  const fields = [
    element({ id: 'e1', label: 'Yes' }),
    element({ id: 'e2', label: 'Do you now, or in the future require sponsorship?' }),
    element({ id: 'e3', label: 'Do you have the unrestricted right to work in the United States?' }),
  ]
  assert.equal(fieldMatchingError('Please select: Do you now, or in the future require sponsorship? This field is required', fields), 'e2')
})

test('after a failed submit, repair the unmatched empty radios', () => {
  const repaired = fieldsToRepairAfterSubmit({
    pageText: 'This field is required\nPlease complete the required fields',
    elements: [
      element({ id: 'e1', label: 'Full name', role: 'textbox', filled: true, value: 'Azhar', required: true }),
      element({ id: 'e2', label: 'Do you now, or in the future require sponsorship?', filled: false }),
    ],
  })
  assert.equal(repaired[0]?.id, 'e2')
})
