import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dropdownQueries, isLocationDropdown, isReferralDropdown, pickAnyReferralChoice, pickDropdownChoice, scoreOption, shouldFillDropdown } from './dropdowns.js'

describe('dropdown query expansion', () => {
  it('expands a city into location typeahead queries', () => {
    const queries = dropdownQueries(
      { label: 'Location', type: 'combobox', required: true },
      'Bengaluru',
      { city: 'Bengaluru', region: 'Karnataka', country: 'India' },
    )
    assert.ok(queries.includes('Bengaluru'))
    assert.ok(queries.includes('Bengaluru, India'))
    assert.ok(queries.includes('Bengaluru, Karnataka, India'))
  })

  it('tries common job-source aliases when the form asks how you heard', () => {
    const queries = dropdownQueries({ label: 'How did you learn about this opportunity with Atlan?', type: 'combobox', required: true }, 'Job board')
    assert.ok(queries.includes('Job board'))
    assert.ok(queries.includes('LinkedIn'))
    assert.ok(queries.includes('Indeed'))
  })

  it('does not treat relocation as a location dropdown', () => {
    assert.equal(isLocationDropdown({ label: 'Are you willing to relocate?', type: 'text', required: true }), false)
    assert.equal(isLocationDropdown({ label: 'Location preference for this role', type: 'text', required: false }), false)
    assert.equal(isLocationDropdown({ label: 'Location', type: 'combobox', required: true }), true)
    assert.equal(isLocationDropdown({ label: 'Location (City)*', type: 'combobox', required: true }), true)
    assert.equal(isLocationDropdown({ label: 'Country*', type: 'combobox', required: true }), true)
    assert.equal(isReferralDropdown({ label: 'How did you hear about us?*', type: 'combobox', required: true }), true)
    assert.equal(isReferralDropdown({ label: 'How did you learn about this opportunity with Atlan?', type: 'combobox', required: false }), true)
    assert.equal(isReferralDropdown({ label: 'Where did you find out about this role?', type: 'combobox', required: true }), true)
    assert.equal(shouldFillDropdown({ label: 'Gender', type: 'select-one', required: true }), true)
  })
})

describe('dropdown option scoring', () => {
  it('picks a typeahead city that contains the typed query', () => {
    assert.equal(
      pickDropdownChoice(['Berlin, Germany', 'Bengaluru, Karnataka, India', 'Bengaluru, India'], ['Bengaluru']),
      'Bengaluru, Karnataka, India',
    )
    assert.ok(scoreOption('Bengaluru', 'Bengaluru, Karnataka, India') >= 70)
  })

  it('picks LinkedIn when Job board is not in the source list', () => {
    assert.equal(pickDropdownChoice(['LinkedIn', 'Indeed', 'Other'], ['Job board', 'LinkedIn']), 'LinkedIn')
  })

  it('picks any real source option when nothing matches', () => {
    assert.equal(pickAnyReferralChoice(['Career fair', 'University'], ['Job board', 'LinkedIn']), 'Career fair')
    assert.equal(pickAnyReferralChoice(['Select...', 'Other'], ['Job board']), 'Other')
  })

  it('ignores Select... placeholders', () => {
    assert.equal(pickDropdownChoice(['Select...', 'India', 'United States'], ['India']), 'India')
    assert.equal(scoreOption('India', 'Select...'), 0)
  })
})
