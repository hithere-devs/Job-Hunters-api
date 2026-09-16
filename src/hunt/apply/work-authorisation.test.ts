import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { answerForField, classifyAuthorisationQuestion, countryCodeFor, deriveAuthorisation } from './work-authorisation.js'

const field = (label: string, options?: string[], type = 'select') => ({ label, type, required: true, ...(options ? { options } : {}) })
const inIndia = { candidateCountry: 'IN', jobCountries: ['US'] }
const indiaJob = { candidateCountry: 'IN', jobCountries: ['IN'] }

describe('classifying the question', () => {
  it('tells sponsorship apart from authorisation', () => {
    // The topics overlap in wording but are independent user facts.
    assert.equal(classifyAuthorisationQuestion('Will you now or in the future require visa sponsorship?'), 'sponsorship')
    assert.equal(classifyAuthorisationQuestion('Are you legally authorized to work in the United States?'), 'authorised')
    assert.equal(classifyAuthorisationQuestion('Do you require sponsorship to work in the US?'), 'sponsorship')
    assert.equal(classifyAuthorisationQuestion('What is your notice period?'), null)
  })
})

describe('matching explicit country answers', () => {
  it('never derives work rights or sponsorship from home or foreign residence', () => {
    for (const context of [inIndia, indiaJob]) {
      assert.equal(deriveAuthorisation(field('Are you authorized to work here?'), context), null)
      assert.equal(deriveAuthorisation(field('Will you require sponsorship?'), context), null)
    }
  })
  it('uses a previously explicit sponsorship answer without assuming authorization', () => {
    const context = { ...inIndia, explicitAnswers: { US: { sponsorship: true } } }
    assert.equal(deriveAuthorisation(field('Will you require visa sponsorship?'), context)?.answer, true)
    assert.equal(deriveAuthorisation(field('Are you authorized to work here?'), context), null)
  })
  it('prefers the named country and requires an explicit answer there', () => {
    const context = { ...inIndia, explicitAnswers: { GB: { authorised: true }, US: { authorised: false } } }
    const verdict = deriveAuthorisation(field('Do you have the right to work in the United Kingdom?'), context)
    assert.equal(verdict?.answer, true)
    assert.equal(verdict?.jurisdiction, 'GB')
    assert.match(verdict!.basis, /Explicit user authorised answer for GB/)
    assert.equal(deriveAuthorisation(field('Do you have the right to work in Canada?'), context), null)
  })
  it('does not choose a jurisdiction from an ambiguous job location', () => {
    assert.equal(deriveAuthorisation(field('Are you authorized to work here?'), { ...inIndia, jobCountries: ['US', 'GB'], explicitAnswers: { US: { authorised: true } } }), null)
  })
})

describe('shaping the answer for the control', () => {
  it('picks the option the form actually offers', () => {
    assert.equal(answerForField(field('x', ['Yes', 'No']), true), 'Yes')
    assert.equal(answerForField(field('x', ['Yes', 'No']), false), 'No')
    assert.equal(answerForField(field('x', ['Yes, I am authorized', 'No, I will need sponsorship']), true), 'Yes, I am authorized')
  })

  it('returns nothing rather than forcing a value the control lacks', () => {
    // Writing "Yes" into a select that offers neither is not an answer.
    assert.equal(answerForField(field('x', ['Authorized', 'Requires sponsorship']), true), null)
  })

  it('handles checkboxes and bare inputs', () => {
    assert.equal(answerForField(field('x', undefined, 'checkbox'), true), 'true')
    assert.equal(answerForField(field('x', undefined, 'text'), false), 'No')
  })
})

describe('country codes', () => {
  it('reads the free-text country a profile stores', () => {
    assert.equal(countryCodeFor('India'), 'IN')
    assert.equal(countryCodeFor('United States'), 'US')
    assert.equal(countryCodeFor('IN'), 'IN')
    assert.equal(countryCodeFor(null), null)
    assert.equal(countryCodeFor('Atlantis'), null)
  })
})
