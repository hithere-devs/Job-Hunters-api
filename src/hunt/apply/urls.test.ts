import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isPlausibleWebsiteUrl, normaliseHttpUrl } from './urls.js'

describe('application URL normalisation', () => {
  it('adds https to a domain-like value', () => {
    assert.equal(normaliseHttpUrl('linkedin.com/in/example'), 'https://linkedin.com/in/example')
  })

  it('extracts the destination from a Markdown link', () => {
    assert.equal(
      normaliseHttpUrl('[https://linked.in](https://linked.in)'),
      'https://linked.in/',
    )
  })

  it('leaves a valid URL intact', () => {
    assert.equal(normaliseHttpUrl('https://example.com/apply?id=42'), 'https://example.com/apply?id=42')
  })

  it('does not turn blank values into a destination', () => {
    assert.equal(normaliseHttpUrl('  '), '')
  })

  it('does not treat skill tokens as websites', () => {
    assert.equal(normaliseHttpUrl('Next.js'), '')
    assert.equal(normaliseHttpUrl('https://next.js/'), '')
    assert.equal(normaliseHttpUrl('Node.js'), '')
    assert.equal(isPlausibleWebsiteUrl('Vue.js'), false)
    assert.equal(normaliseHttpUrl('https://ayan.dev'), 'https://ayan.dev/')
  })
})
