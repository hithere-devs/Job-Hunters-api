import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canReuseExplicitAnswer, fieldSignature, heuristicMatch, sensitiveReason, valueFromProfile, normaliseLabel } from './fields.js'
import type { PortalProfile } from '../portal-profile.js'

const profile = {
  fullName: 'Ayan Mansoori',
  email: 'ayan@example.com',
  phone: '+91 90000 00000',
  headline: 'Backend Engineer',
  noticePeriod: '30 days',
  workAuthorization: '',
  address: {
    line1: '1 Example Road',
    city: 'Bengaluru',
    region: 'Karnataka',
    postalCode: '560001',
    country: 'India',
  },
  links: {
    linkedin: 'linkedin.com/in/example',
    github: 'github.com/example',
    portfolio: '',
  },
} as unknown as PortalProfile

describe('questions we refuse to answer', () => {
  it('does not refuse consent or privacy acknowledgements', () => {
    assert.equal(sensitiveReason('Candidate Privacy Policy*'), null)
    assert.equal(sensitiveReason('By checking this box, I agree to allow you to store and process my data'), null)
  })
  it('refuses demographic questions', () => {
    // Getting one of these wrong on someone's application is not a bug you can
    // apologise for afterwards.
    for (const label of [
      'Gender',
      'What is your race / ethnicity?',
      'Are you Hispanic or Latino?',
      'Veteran status',
      'Do you have a disability?',
    ]) {
      assert.ok(sensitiveReason(label), `should refuse: ${label}`)
    }
  })

  it('refuses salary expectations', () => {
    assert.ok(sensitiveReason('Expected salary'))
    assert.ok(sensitiveReason('Salary expectation (INR)'))
    assert.ok(sensitiveReason('Desired compensation'))
  })

  it('refuses visa and work-authorisation questions', () => {
    assert.ok(sensitiveReason('Will you require sponsorship?'))
    assert.ok(sensitiveReason('Work authorization'))
    assert.ok(sensitiveReason('Do you have the right to work in the UK?'))
  })

  it('refuses background and reference questions', () => {
    assert.ok(sensitiveReason('Have you ever been convicted of a felony?'))
    assert.ok(sensitiveReason('Reference email'))
  })

  it('still answers ordinary fields', () => {
    for (const label of ['Full name', 'Email', 'Phone', 'LinkedIn URL', 'City']) {
      assert.equal(sensitiveReason(label), null, `should answer: ${label}`)
    }
  })

  it('catches the phrasings real ATS forms actually use', () => {
    // Taken from live Greenhouse, Lever and Ashby forms.
    for (const label of [
      'Are you legally authorized to work in the United States?',
      'Will you now or in the future require sponsorship for employment visa status?',
      'What are your compensation expectations?',
      'Desired Salary Range',
      'Voluntary Self-Identification of Disability',
      'Please select your gender',
      'Minimum expected CTC',
    ]) {
      assert.ok(sensitiveReason(label), `should refuse: ${label}`)
    }
  })

  it('catches an unlabelled group by what it offers', () => {
    // Ashby renders gender as a radio group with no legend, so the label ends
    // up being the first option. The options give it away.
    assert.ok(sensitiveReason('Male', ['Male', 'Female', 'Non-binary', 'Prefer not to say']))
    assert.ok(
      sensitiveReason('Hispanic or Latino', ['Hispanic or Latino', 'White', 'Asian', 'Prefer not to say']),
    )
  })

  it('does not treat an ordinary two-option question as demographic', () => {
    assert.equal(sensitiveReason('Do you have a laptop?', ['Yes', 'No']), null)
    assert.equal(sensitiveReason('Preferred start date', ['Immediately', 'In a month']), null)
  })

  it('does not confuse current salary with an expectation prompt on a name field', () => {
    // "Salary" alone should not trip the expectation rule on unrelated labels.
    assert.equal(sensitiveReason('Salary History Verification Contact Name'), null)
  })
})

describe('field signatures', () => {
  const base = { label: 'Email', type: 'email', required: true }

  it('ignores cosmetic differences', () => {
    assert.equal(
      fieldSignature({ ...base, label: 'Email' }),
      fieldSignature({ ...base, label: '  email  ' }),
    )
    assert.equal(
      fieldSignature({ ...base, label: 'Email' }),
      fieldSignature({ ...base, label: 'Email*' }),
    )
  })

  it('separates genuinely different fields', () => {
    assert.notEqual(
      fieldSignature({ ...base, label: 'Email' }),
      fieldSignature({ ...base, label: 'Personal email' }),
    )
    assert.notEqual(
      fieldSignature({ ...base, label: 'Email', type: 'email' }),
      fieldSignature({ ...base, label: 'Email', type: 'text' }),
    )
  })
})

describe('heuristic mapping', () => {
  it('maps the labels that cover most forms', () => {
    assert.equal(heuristicMatch({ label: 'First Name', type: 'text', required: true }), 'firstName')
    assert.equal(heuristicMatch({ label: 'E-mail', type: 'email', required: true }), 'email')
    assert.equal(heuristicMatch({ label: 'Mobile', type: 'tel', required: false }), 'phone')
    assert.equal(heuristicMatch({ label: 'LinkedIn Profile', type: 'text', required: false }), 'linkedin')
    assert.equal(heuristicMatch({ label: 'PIN code', type: 'text', required: false }), 'postalCode')
    assert.equal(heuristicMatch({ label: 'When can you start?', type: 'text', required: false }), 'noticePeriod')
  })

  it('maps a bare "Location" label to the city on file', () => {
    // From a live Ashby form. This was blocking real applications as an
    // `unknown_field` while the answer sat in the kit the whole time.
    assert.equal(heuristicMatch({ label: 'Location', type: 'text', required: true }), 'city')
    assert.equal(heuristicMatch({ label: 'Location*', type: 'text', required: true }), 'city')
    assert.equal(heuristicMatch({ label: 'Current Location', type: 'text', required: true }), 'city')
  })

  it('does not treat a relocation question as a location field', () => {
    // These ask something else entirely, and filling a city into them is wrong.
    assert.notEqual(heuristicMatch({ label: 'Are you willing to relocate?', type: 'text', required: true }), 'city')
    assert.notEqual(heuristicMatch({ label: 'Location preference for this role', type: 'text', required: false }), 'city')
  })

  it('does not match a phrase buried in a long question', () => {
    // From a live GitLab form. "current employer" appears, but the question is
    // legal and the answer is not a company name.
    const label =
      'Are you subject to any employment agreements and/or restrictive covenants with your current employer?'
    assert.equal(heuristicMatch({ label, type: 'text', required: true }), null)
    // And it is refused outright, so no rung tries to answer it.
    assert.ok(sensitiveReason(label))
  })

  it('returns nothing for a question it does not recognise', () => {
    assert.equal(
      heuristicMatch({ label: 'Describe a system you are proud of', type: 'textarea', required: false }),
      null,
    )
  })

  it('reads values off the profile, and reports empties as missing', () => {
    assert.equal(valueFromProfile('firstName', profile), 'Ayan')
    assert.equal(valueFromProfile('lastName', profile), 'Mansoori')
    assert.equal(valueFromProfile('city', profile), 'Bengaluru')
    // An empty string is not an answer.
    assert.equal(valueFromProfile('portfolio', profile), null)
    assert.equal(valueFromProfile('nonsense', profile), null)
  })
})

describe('label normalisation', () => {
  it('strips the required markers forms actually use', () => {
    // Lever renders a heavy asterisk, not the ASCII one. Matching the raw
    // label meant an anchored pattern failed on the candidate's own name.
    assert.equal(normaliseLabel('Full name✱'), 'Full name')
    assert.equal(normaliseLabel('First Name*'), 'First Name')
    assert.equal(normaliseLabel('Email:'), 'Email')
    assert.equal(normaliseLabel('Phone (required)'), 'Phone')
  })

  it('collapses whitespace without changing the words', () => {
    assert.equal(normaliseLabel('  Current   company  '), 'Current company')
  })

  it('leaves an ordinary label alone', () => {
    assert.equal(normaliseLabel('LinkedIn URL'), 'LinkedIn URL')
  })
})

describe('reusing answers the user gave explicitly', () => {
  const field = (label: string, options?: string[]) => ({ label, type: 'text', required: true, ...(options ? { options } : {}) })

  it('reuses work authorisation when the question names the country', () => {
    // The reported bug: these were stored with remember:true and then refused
    // on the way back out, so every application asked again. Refusing to guess
    // a visa status is right; refusing to reuse one the user typed is amnesia.
    assert.equal(canReuseExplicitAnswer(field('Are you legally authorized to work in the United States?')), true)
    assert.equal(canReuseExplicitAnswer(field('Do you have the right to work in the UK?')), true)
    assert.equal(canReuseExplicitAnswer(field('Will you require visa sponsorship to work in India?')), true)
  })

  it('does not reuse a work-authorisation answer that depends on the job', () => {
    // Same person, different answer: yes in Bengaluru, no in New York. Reusing
    // one of these would put a wrong answer on a real application.
    assert.equal(canReuseExplicitAnswer(field('Are you legally authorized to work in the country where you are applying?')), false)
    assert.equal(canReuseExplicitAnswer(field('Will you require sponsorship?')), false)
    assert.equal(canReuseExplicitAnswer(field('Are you authorised to work where this role is located?')), false)
  })

  it('still refuses to guess those questions on its own', () => {
    // Reuse and inference are different rungs. The refusal list is untouched.
    assert.ok(sensitiveReason('Are you legally authorized to work in the United States?'))
    assert.ok(sensitiveReason('Will you now or in the future require visa sponsorship?'))
  })

  it('does not carry over anything scoped to one application', () => {
    assert.equal(canReuseExplicitAnswer(field('Reference name and contact email')), false)
    assert.equal(canReuseExplicitAnswer(field('Have you ever been convicted of a felony?')), false)
    assert.equal(canReuseExplicitAnswer(field('Are you subject to any restrictive covenants with your current employer?')), false)
    assert.equal(canReuseExplicitAnswer(field('I certify the above information is accurate')), false)
  })

  it('reuses demographics the user chose to disclose', () => {
    assert.equal(canReuseExplicitAnswer(field('Input gender', ['Male', 'Female', 'Prefer not to say'])), true)
  })

  it('never reuses a credential or a motivation answer', () => {
    assert.equal(canReuseExplicitAnswer(field('One time code')), false)
    assert.equal(canReuseExplicitAnswer(field('Why do you want to join us?')), false)
  })
})
