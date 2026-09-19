import assert from 'node:assert/strict'
import { it } from 'node:test'
import { draftApplicationAnswer } from './answer-draft.js'
const facts = { role: 'Engineer', company: 'ExampleCo', headline: 'Backend Engineer', skills: ['TypeScript', 'SQL'], jobSkills: ['TypeScript'], experience: [{ role: 'Engineer', company: 'PriorCo', description: 'Built database import tooling.' }] }
it('drafts only saved facts and asks for company motivation instead of inventing it', () => {
  const result = draftApplicationAnswer({ label: 'Why this company?', type: 'textarea', required: true }, facts)
  assert.ok(result.draft?.includes('PriorCo'))
  assert.ok(result.needsInfo.some((value) => /own reason/.test(value)))
  assert.ok(result.draft!.split(/\s+/).length <= 60)
  assert.ok(!result.draft?.includes('mission'))
})
it('does not generate sensitive or secret answers', () => {
  for (const label of ['Expected salary', 'Work authorization', 'Gender', 'Password', 'OTP', 'Criminal history']) assert.equal(draftApplicationAnswer({ label, type: 'text', required: true }, facts).draft, null)
})
it('asks for missing facts rather than inventing experience', () => {
  const result = draftApplicationAnswer({ label: 'Describe your experience', type: 'textarea', required: true }, { role: 'Engineer', company: 'ExampleCo', skills: [], jobSkills: [], experience: [] })
  assert.equal(result.draft, null)
  assert.ok(result.needsInfo.length > 0)
})
it('drafts a cover letter from saved experience instead of leaving the field blank', () => {
  const result = draftApplicationAnswer({ label: 'Cover Letter', type: 'textarea', required: true }, facts)
  assert.ok(result.draft?.includes('PriorCo'))
})
