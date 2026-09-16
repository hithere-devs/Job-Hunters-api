import assert from 'node:assert/strict'
import { it } from 'node:test'
import { APPLY_QUESTION_SPECS, applyFieldsSchema, commonSensitiveQuestionId } from './application-questions.js'
it('common onboarding schema rejects credentials and permits skipping sensitive fields', () => {
  assert.equal(applyFieldsSchema.safeParse({}).success, true)
  assert.equal(applyFieldsSchema.safeParse({ password: 'secret' }).success, false)
  assert.equal(applyFieldsSchema.safeParse({ email: 'not-an-email' }).success, false)
  assert.equal(applyFieldsSchema.safeParse({ portfolioUrl: 'javascript:alert(1)' }).success, false)
  assert.ok(APPLY_QUESTION_SPECS.filter((spec) => 'sensitive' in spec).every((spec) => !spec.required))
})
it('does not translate generic work authorization or salary into country-specific yes/no claims', () => {
  assert.equal(commonSensitiveQuestionId('Work authorization', 'text'), 'workAuthorization')
  assert.equal(commonSensitiveQuestionId('Are you authorized to work in the USA?', 'text'), null)
  assert.equal(commonSensitiveQuestionId('Expected salary (USD)', 'text'), null)
  assert.equal(commonSensitiveQuestionId('Work authorization', 'select'), null)
})

import { canonicalCommonQuestionKey } from './application-questions.js'
it('groups only semantically identical personal contact/profile questions', () => {
  for (const label of ['LinkedIn URL', 'LinkedIn Profile', 'LinkedIn Profile - no fact provided', 'Your LinkedIn profile URL*']) assert.equal(canonicalCommonQuestionKey({ label, type: 'text' }), 'linkedinUrl')
  for (const label of ['Preferred name', 'Name', 'Employer email', 'Reference phone number', 'Are you authorized to work in the USA?', 'Expected salary', 'Company website', 'Why this company?', 'LinkedIn password']) assert.equal(canonicalCommonQuestionKey({ label, type: 'text' }), null)
  assert.equal(canonicalCommonQuestionKey({ label: 'Email', type: 'select', options: ['yes', 'no'] }), null)
  assert.equal(canonicalCommonQuestionKey({ label: 'Phone number', type: 'tel' }), 'phone')
  assert.equal(canonicalCommonQuestionKey({ label: 'Full name', type: 'text' }), 'fullName')
})
it('rejects URLs containing credentials rather than storing them as a profile fact', () => {
  assert.equal(applyFieldsSchema.safeParse({ linkedinUrl: 'https://user:password@example.com' }).success, false)
})
