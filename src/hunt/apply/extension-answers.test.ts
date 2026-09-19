import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { acceptBatchAnswer, isBatchResidue } from './extension-answers.js'
import type { ResolvedApplicationAnswer } from '../../persona/answer-resolver-policy.js'
import type { FormField } from './fields.js'

const lastName: FormField = { fid: 'f7', label: 'Last Name', type: 'text', required: true }
const workAuth: FormField = {
  fid: 'f12',
  label: 'Are you legally authorized to work in the United States?',
  type: 'checkbox',
  required: true,
  options: ['Yes', 'No'],
}
const gender: FormField = { fid: 'f20', label: 'Gender', type: 'select-one', required: true, options: ['Male', 'Female', 'Decline to identify'] }
const salary: FormField = { fid: 'f21', label: 'Expected salary', type: 'text', required: true }

function answer(partial: Partial<ResolvedApplicationAnswer> & Pick<ResolvedApplicationAnswer, 'questionId'>): ResolvedApplicationAnswer {
  return {
    decision: 'known',
    answer: 'Mansoori',
    confidence: 1,
    evidence: [{ sourceId: 'kit:lastName', quote: 'Mansoori' }],
    reason: 'cited',
    missingInfo: [],
    autoApply: false,
    ...partial,
  }
}

describe('extension batch post-filters', () => {
  it('accepts a cited answer keyed by fid', () => {
    assert.equal(acceptBatchAnswer(lastName, answer({ questionId: 'f7' })), 'Mansoori')
  })

  it('drops an answer keyed to the wrong fid', () => {
    assert.equal(acceptBatchAnswer(lastName, answer({ questionId: 'f8' })), null)
  })

  it('drops a known answer with no evidence', () => {
    assert.equal(acceptBatchAnswer(lastName, answer({ questionId: 'f7', evidence: [] })), null)
  })

  it('requires an exact option for yes/no', () => {
    assert.equal(acceptBatchAnswer(workAuth, answer({
      questionId: 'f12',
      answer: 'Nope',
      evidence: [{ sourceId: 'kit:residence', quote: 'The candidate lives and works in India.' }],
    })), null)
    assert.equal(acceptBatchAnswer(workAuth, answer({
      questionId: 'f12',
      answer: 'No',
      evidence: [{ sourceId: 'kit:residence', quote: 'The candidate lives and works in India.' }],
    })), 'No')
  })

  it('never writes demographics even with evidence', () => {
    assert.equal(acceptBatchAnswer(gender, answer({
      questionId: 'f20',
      answer: 'Male',
      evidence: [{ sourceId: 'saved:1', quote: 'Male' }],
    })), null)
  })

  it('never writes salary from the batch', () => {
    assert.equal(acceptBatchAnswer(salary, answer({
      questionId: 'f21',
      answer: '120000',
      evidence: [{ sourceId: 'saved:2', quote: '120000' }],
    })), null)
  })

  it('sends work-auth residue to the batch after the ladder blocks it', () => {
    assert.equal(isBatchResidue(workAuth, { value: null, blocked: 'sensitive_field' }), true)
    assert.equal(isBatchResidue(gender, { value: null, blocked: 'sensitive_field' }), false)
    assert.equal(isBatchResidue(lastName, { value: 'Mansoori' }), false)
  })
})
