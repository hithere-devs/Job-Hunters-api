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
