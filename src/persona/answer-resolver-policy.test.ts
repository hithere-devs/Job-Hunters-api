import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { answerTopic, conditionalCountryAnswer, countryForQuestion, inferApplicationAnswer, sourcesForQuestion, validateAnswerProposal, type AnswerSource, type ProposedAnswer, type ResolverQuestion } from './answer-resolver-policy.js'

const question: ResolverQuestion = { id: 'q', applicationId: 'app', label: 'Will you require employment sponsorship in the United States?', type: 'select', options: ['Yes', 'No'], required: true, role: 'Engineer', company: 'ExampleCo', location: 'United States' }
const source: AnswerSource = { id: 'source', label: 'Will you require sponsorship?', text: 'India no; USA yes', kind: 'explicit_answer', topic: 'sponsorship' }
const proposed: ProposedAnswer = { questionId: 'q', decision: 'known', answer: 'Yes', confidence: 0.99, evidence: [{ sourceId: 'source', quote: 'India no; USA yes' }], reason: 'Explicit US answer', missingInfo: [] }

describe('profile AI answer validation', () => {
  it('uses an explicit conditional answer only for the matching country and topic', () => {
    assert.equal(conditionalCountryAnswer(source, 'US'), 'yes')
    assert.equal(conditionalCountryAnswer(source, 'IN'), 'no')
    assert.equal(validateAnswerProposal(question, [source], proposed).autoApply, true)
    assert.equal(validateAnswerProposal({ ...question, label: 'Will you require sponsorship in the UK?', location: 'United Kingdom' }, [source], proposed).autoApply, false)
    assert.equal(validateAnswerProposal({ ...question, label: 'Are you authorized to work in the USA?' }, [source], proposed).autoApply, false)
  })
  it('does not infer citizenship/work status from a resume or address', () => {
    assert.equal(validateAnswerProposal(question, [{ ...source, kind: 'resume' }], proposed).decision, 'ask')
    assert.equal(validateAnswerProposal(question, [{ ...source, topic: 'contact', text: 'Lives in USA' }], { ...proposed, evidence: [{ sourceId: 'source', quote: 'Lives in USA' }] }).decision, 'ask')
  })
  it('does not treat the pronoun us or an unstated country as the United States', () => {
    assert.equal(countryForQuestion({ ...question, label: 'Tell us whether you need sponsorship', location: null }), null)
  })
  it('rejects fabricated evidence, unknown source IDs, unsupported choices and low confidence', () => {
    for (const patch of [
      { evidence: [{ sourceId: 'source', quote: 'USA no' }] }, { evidence: [{ sourceId: 'other', quote: source.text }] }, { answer: 'yes' }, { confidence: 0.7 },
    ]) assert.equal(validateAnswerProposal(question, [source], { ...proposed, ...patch }).decision, 'ask')
  })
  it('does not convert salary currency or pay periods', () => {
    const salaryQuestion = { ...question, label: 'Expected salary (USD annually)', type: 'text', options: [] }
    const salarySource: AnswerSource = { id: 'source', label: 'Expected salary', text: 'INR 2400000 per year', kind: 'explicit_answer', topic: 'salary_expected' }
    assert.equal(validateAnswerProposal(salaryQuestion, [salarySource], { ...proposed, answer: salarySource.text, evidence: [{ sourceId: 'source', quote: salarySource.text }] }).decision, 'ask')
  })
  it('never emits a sensitive draft or accepts unrelated demographic sources in a professional essay', () => {
    const demographic: AnswerSource = { id: 'gender', label: 'Gender', text: 'Female', kind: 'explicit_answer', topic: 'gender' }
    const essay = { ...question, label: 'Describe your professional experience', type: 'textarea', options: [] }
    assert.deepEqual(sourcesForQuestion(essay, [demographic]), [])
    const genderQuestion = { ...question, label: 'Gender', type: 'text', options: [] }
    assert.equal(validateAnswerProposal(genderQuestion, [demographic], { ...proposed, decision: 'draft', answer: 'Female', evidence: [{ sourceId: 'gender', quote: 'Female' }] }).decision, 'ask')
  })
  it('accepts a short professional draft grounded in verified citations', () => {
    const fact: AnswerSource = { id: 'fact', label: 'Professional experience', text: 'Built TypeScript services and maintained PostgreSQL databases.', kind: 'profile', topic: 'professional' }
    const essay = { ...question, label: 'Describe your relevant professional experience', type: 'textarea', options: [] }
    const result = validateAnswerProposal(essay, [fact], { ...proposed, decision: 'draft', answer: 'I invented a million-dollar product.', evidence: [{ sourceId: 'fact', quote: fact.text }] })
    assert.equal(result.answer, 'I invented a million-dollar product.')
    assert.equal(result.decision, 'draft')
    assert.equal(result.autoApply, true)
    assert.equal(validateAnswerProposal({ ...essay, label: 'Tell us about a time you resolved a conflict' }, [fact], { ...proposed, decision: 'draft', answer: fact.text, evidence: [{ sourceId: 'fact', quote: fact.text }] }).decision, 'ask')
  })
  it('blocks secrets before source lookup or model resolution', () => {
    for (const label of ['Password', 'API key', 'Access token', 'Refresh token', 'Private key', 'Recovery secret', 'OTP', 'CAPTCHA']) {
      assert.equal(answerTopic({ label, type: 'text' }), 'credential')
      assert.equal(validateAnswerProposal({ ...question, label, type: 'text' }, [source], proposed).decision, 'ask')
    }
  })
})

it('infers repeatable application answers and marks them as inferred', () => {
  const employment: AnswerSource = { id: 'job', label: 'Professional experience', text: 'Technical Lead at Samora AI.', kind: 'resume', topic: 'professional' }
  const priorEmployer = { ...question, label: 'Have you ever worked at MongoDB before?', company: 'MongoDB', type: 'text', options: [] }
  assert.deepEqual(inferApplicationAnswer(priorEmployer, [employment]), {
    questionId: 'q', decision: 'known', answer: 'No', confidence: 0.9,
    evidence: [{ sourceId: 'job', quote: employment.text }], reason: 'inferred_from_saved_profile', missingInfo: [], autoApply: true,
  })
  assert.equal(inferApplicationAnswer({ ...question, label: 'SMS consent', type: 'select', options: ['Yes', 'No'] }, [])?.answer, 'No')
  assert.equal(inferApplicationAnswer({ ...question, label: 'What are your compensation expectations?', type: 'text', options: [] }, [])?.answer, 'Open to discussion based on the role scope and total compensation.')
})
it('does not turn total years into skill-specific years or a date digit into experience', () => {
  const q = { ...question, label: 'How many years of experience do you have with React?', type: 'number', options: [] }
  const total: AnswerSource = { id: 'source', label: 'Total years of professional experience', text: '5', kind: 'resume', topic: 'professional' }
  assert.equal(validateAnswerProposal(q, [total], { ...proposed, answer: '5', evidence: [{ sourceId: 'source', quote: '5' }] }).decision, 'ask')
  const year: AnswerSource = { id: 'source', label: 'Professional experience', text: 'Worked during 2025', kind: 'resume', topic: 'professional' }
  assert.equal(validateAnswerProposal({ ...q, label: 'Total years of experience' }, [year], { ...proposed, answer: '5', evidence: [{ sourceId: 'source', quote: year.text }] }).decision, 'ask')
})

import { canUsePriorHumanAnswer } from './answer-resolver-policy.js'
it('honors old cross-application opt-outs while allowing same-application answers and explicit opt-in', () => {
  const current = new Set(['current'])
  assert.equal(canUsePriorHumanAnswer({ applicationId: 'current', remember: false, answerMeta: {} }, current), true)
  assert.equal(canUsePriorHumanAnswer({ applicationId: 'other', remember: false, answerMeta: { source: 'user' } }, current), false)
  assert.equal(canUsePriorHumanAnswer({ applicationId: 'other', remember: true, answerMeta: { source: 'user' } }, current), true)
  assert.equal(canUsePriorHumanAnswer({ applicationId: 'current', remember: true, answerMeta: { source: 'profile_ai' } }, current), false)
})
it('parses explicit comma-separated country answers without assigning ambiguous or lowercase us clauses', () => {
  const comma = { ...source, text: 'For India no, for USA yes' }
  assert.equal(conditionalCountryAnswer(comma, 'IN'), 'no')
  assert.equal(conditionalCountryAnswer(comma, 'US'), 'yes')
  assert.equal(conditionalCountryAnswer(comma, 'GB'), null)
  assert.equal(conditionalCountryAnswer({ ...source, text: 'For India or USA no' }, 'US'), null)
  assert.equal(conditionalCountryAnswer({ ...source, text: 'For India no, tell us yes' }, 'US'), null)
  assert.equal(conditionalCountryAnswer({ ...source, text: 'For India no, for USA yes or no' }, 'US'), null)
})

describe('work authorisation reasoned from the profile', () => {
  // Every work-authorisation question used to end in `country_answer_not_explicit`
  // unless the user had already typed a country-specific answer on an earlier
  // posting — so in practice each application stopped on them. Residence is now
  // citable evidence the model may reason from.
  const residence: AnswerSource = { id: 'kit:residence', label: 'Country of residence', text: 'The candidate lives and works in India.', kind: 'profile', topic: 'work_authorization', country: 'IN' }
  const usQuestion: ResolverQuestion = { id: 'q', applicationId: 'app', label: 'Will you require employment sponsorship in the United States?', type: 'select', options: ['Yes', 'No'], required: true, role: 'Engineer', company: 'ExampleCo', location: 'United States' }
  const cite = (answer: string): ProposedAnswer => ({ questionId: 'q', decision: 'known', answer, confidence: 0.99, evidence: [{ sourceId: 'kit:residence', quote: 'The candidate lives and works in India.' }], reason: 'Derived from residence', missingInfo: [] })

  it('answers a US sponsorship question from an Indian residence', () => {
    assert.equal(validateAnswerProposal(usQuestion, [residence], cite('Yes')).autoApply, true)
  })

  it('answers the home-country case the other way', () => {
    const inQuestion = { ...usQuestion, label: 'Will you require employment sponsorship in India?', location: 'India' }
    assert.equal(validateAnswerProposal(inQuestion, [residence], cite('No')).autoApply, true)
  })

  it('still refuses an answer the field does not offer', () => {
    // The whole point of "a format acceptable in the form": an answer that is
    // not one of the options is not an answer.
    assert.equal(validateAnswerProposal({ ...usQuestion, options: ['Authorized', 'Requires sponsorship'] }, [residence], cite('Yes')).decision, 'ask')
  })

  it('still needs a country from the question or the posting', () => {
    const vague = { ...usQuestion, label: 'Will you require sponsorship?', location: null }
    assert.equal(validateAnswerProposal(vague, [residence], cite('Yes')).decision, 'ask')
  })

  it('does not extend the relaxation to demographics or salary', () => {
    // Residence says nothing about these, and the strict rule still holds.
    const demographic: ResolverQuestion = { ...usQuestion, label: 'What is your gender?', options: ['Male', 'Female', 'Prefer not to say'] }
    assert.equal(validateAnswerProposal(demographic, [{ ...residence, topic: 'gender' }], cite('Male')).decision, 'ask')
    const salary: ResolverQuestion = { ...usQuestion, label: 'What is your expected salary?', type: 'text', options: undefined }
    assert.equal(validateAnswerProposal(salary, [{ ...residence, topic: 'salary_expected' }], cite('100000')).decision, 'ask')
  })
})
