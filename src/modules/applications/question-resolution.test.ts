import assert from 'node:assert/strict'
import { it } from 'node:test'
import { approvedResolvedAnswer } from './question-resolution.js'

const question = {
  label: 'What are your compensation expectations for this role?',
  type: 'text',
  fieldName: 'compensation',
  required: true,
  options: [],
  sensitive: true,
} as unknown as Parameters<typeof approvedResolvedAnswer>[0]

it('accepts the bounded compensation default without unsupported evidence', () => {
  assert.equal(approvedResolvedAnswer(question, {
    questionId: 'q',
    decision: 'known',
    answer: 'Open to discussion based on the role scope and total compensation.',
    confidence: 0.8,
    evidence: [],
    reason: 'user_authorized_safe_default',
    missingInfo: [],
    autoApply: true,
  }), true)
})

it('accepts application-data processing consent but not credential fields', () => {
  assert.equal(approvedResolvedAnswer({ ...question, label: 'Resume/CV*', fieldName: 'gdpr_demographic_data_consent_given', type: 'checkbox', sensitive: false }, {
    questionId: 'q', decision: 'known', answer: 'true', confidence: 1, evidence: [],
    reason: 'user_authorized_safe_default', missingInfo: [], autoApply: true,
  }), true)
  assert.equal(approvedResolvedAnswer({ ...question, label: 'One-time password', fieldName: 'otp' }, {
    questionId: 'q', decision: 'known', answer: '123456', confidence: 1, evidence: [],
    reason: 'user_authorized_safe_default', missingInfo: [], autoApply: true,
  }), false)
})
