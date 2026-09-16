import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { answerForField, classifyAuthorisationQuestion, countryCodeFor, deriveAuthorisation } from './work-authorisation.js'

/**
 * The question that kept coming back.
 *
 * A user answered "are you legally authorised to work here?" on application
 * after application, because the answer depends on the posting and a stored one
 * could never be reused. It does not need to be stored — given where the
 * candidate is and where the job is, it follows.
 */

const field = (label: string, options?: string[], type = 'select') => ({ label, type, required: true, ...(options ? { options } : {}) })
const inIndia = { candidateCountry: 'IN', jobCountries: ['US'] }
const indiaJob = { candidateCountry: 'IN', jobCountries: ['IN'] }

describe('classifying the question', () => {
  it('tells sponsorship apart from authorisation', () => {
    // These are inverses, and "require sponsorship to work in the US" matches
    // both wordings — so sponsorship has to win.
    assert.equal(classifyAuthorisationQuestion('Will you now or in the future require visa sponsorship?'), 'sponsorship')
    assert.equal(classifyAuthorisationQuestion('Are you legally authorized to work in the United States?'), 'authorised')
    assert.equal(classifyAuthorisationQuestion('Do you require sponsorship to work in the US?'), 'sponsorship')
    assert.equal(classifyAuthorisationQuestion('What is your notice period?'), null)
  })
})

describe('deriving the answer', () => {
  it('answers a US posting for a candidate in India', () => {
    // The live case: Mercor, Infrastructure Engineer, San Francisco / NYC.
    assert.equal(deriveAuthorisation(field('Are you legally authorized to work in the United States?'), inIndia)?.answer, false)
    assert.equal(deriveAuthorisation(field('Will you require visa sponsorship?'), inIndia)?.answer, true)
  })

  it('answers a home-country posting the other way', () => {
    assert.equal(deriveAuthorisation(field('Are you authorised to work in the country where this role is located?'), indiaJob)?.answer, true)
    assert.equal(deriveAuthorisation(field('Will you require sponsorship?'), indiaJob)?.answer, false)
  })

  it('prefers the country the question names over the job’s', () => {
    // A US company hiring into its UK entity still asks about the UK.
    const verdict = deriveAuthorisation(field('Do you have the right to work in the United Kingdom?'), { candidateCountry: 'GB', jobCountries: ['US'] })
    assert.equal(verdict?.answer, true)
    assert.equal(verdict?.jurisdiction, 'GB')
  })

  it('refuses to answer when it cannot know', () => {
    // No country on the profile, no country on the job, or a posting spanning
    // several — each goes back to the user rather than being guessed.
    assert.equal(deriveAuthorisation(field('Are you authorized to work here?'), { candidateCountry: null, jobCountries: ['US'] }), null)
    assert.equal(deriveAuthorisation(field('Are you authorized to work here?'), { candidateCountry: 'IN', jobCountries: [] }), null)
    assert.equal(deriveAuthorisation(field('Are you authorized to work here?'), { candidateCountry: 'IN', jobCountries: ['US', 'GB'] }), null)
  })

  it('records why, for the audit trail', () => {
    const verdict = deriveAuthorisation(field('Are you legally authorized to work in the United States?'), inIndia)
    assert.match(verdict!.basis, /IN.*US/)
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
