import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hostMatchesDomain, PROVIDERS, providerById, verifyProviders } from './providers.js'

/**
 * These guard two live failures, not hypotheticals.
 *
 * A user signed in to Wellfound could not get past the connect page, twice,
 * because `'wellfound.com'.endsWith('.wellfound.com')` is false and the session
 * cookie `_wellfound` is host-only on the apex. Before that, a user signed in to
 * Google was told they were not, because the check ran against a domain list
 * that could not distinguish a session from a page view.
 */

describe('hostMatchesDomain', () => {
  it('matches a host-only cookie on the apex', () => {
    // The case that broke Wellfound: Chrome writes `wellfound.com` with no
    // leading dot for a host-only cookie, and that is where `_wellfound` lives.
    assert.equal(hostMatchesDomain('wellfound.com', 'wellfound.com'), true)
  })

  it('matches a domain cookie written with a leading dot', () => {
    assert.equal(hostMatchesDomain('.wellfound.com', 'wellfound.com'), true)
  })

  it('matches a subdomain, dotted or not', () => {
    assert.equal(hostMatchesDomain('accounts.google.com', 'google.com'), true)
    assert.equal(hostMatchesDomain('.accounts.google.com', 'google.com'), true)
  })

  it('does not match a lookalike domain', () => {
    // The reason this cannot just be `includes`.
    assert.equal(hostMatchesDomain('notwellfound.com', 'wellfound.com'), false)
    assert.equal(hostMatchesDomain('wellfound.com.evil.test', 'wellfound.com'), false)
    assert.equal(hostMatchesDomain('.google.com.attacker.test', 'google.com'), false)
  })

  it('does not match a different registrable domain', () => {
    assert.equal(hostMatchesDomain('.google.co.in', 'google.com'), false)
  })
})

describe('verifyProviders', () => {
  it('verifies Wellfound from its host-only session cookie', () => {
    const verdict = verifyProviders([{ host: 'wellfound.com', name: '_wellfound' }])
    assert.equal(verdict.find((p) => p.id === 'wellfound')?.verified, true)
  })

  it('refuses to call analytics cookies a session', () => {
    // Exactly what loading wellfound.com while logged out leaves behind. If
    // this passes, the product records a connection that does not exist and the
    // failure surfaces much later, during an application.
    const verdict = verifyProviders([
      { host: '.wellfound.com', name: '_ga' },
      { host: '.wellfound.com', name: '_clck' },
      { host: '.wellfound.com', name: 'TAsessionID' },
      { host: '.wellfound.com', name: 'cf_clearance' },
    ])
    assert.equal(verdict.find((p) => p.id === 'wellfound')?.verified, false)
  })

  it('verifies Google from a real account session cookie', () => {
    const verdict = verifyProviders([
      { host: '.google.com', name: 'SID' },
      { host: 'accounts.google.com', name: 'LSID' },
    ])
    assert.equal(verdict.find((p) => p.id === 'google')?.verified, true)
  })

  it('does not let one provider verify another', () => {
    const verdict = verifyProviders([{ host: '.google.com', name: 'SID' }])
    assert.equal(verdict.find((p) => p.id === 'wellfound')?.verified, false)
    assert.equal(verdict.find((p) => p.id === 'instahyre')?.verified, false)
  })

  it('reports unrecognised cookie names so the registry can be corrected', () => {
    // This is how a wrong guess at a platform's session cookie gets found. The
    // Instahyre entry is a guess; these names are what would fix it.
    const verdict = verifyProviders([
      { host: '.instahyre.com', name: 'some_real_session' },
      { host: '.instahyre.com', name: '_ga' },
    ])
    const instahyre = verdict.find((p) => p.id === 'instahyre')
    assert.equal(instahyre?.verified, false)
    assert.deepEqual(instahyre?.unmatched.sort(), ['_ga', 'some_real_session'])
  })

  it('returns a verdict for every registered provider', () => {
    assert.equal(verifyProviders([]).length, PROVIDERS.length)
  })
})

describe('the registry', () => {
  it('gives every provider a session cookie to look for', () => {
    // A provider with no session cookies can never verify, which would strand
    // a user on that step forever with no visible reason.
    for (const provider of PROVIDERS) {
      assert.ok(provider.sessionCookies.length > 0, `${provider.id} has no session cookies`)
      assert.ok(provider.url.startsWith('https://'), `${provider.id} needs an https url`)
      assert.ok(!provider.domain.startsWith('.'), `${provider.id} domain must not start with a dot`)
    }
  })

  it('has unique ids, and finds them', () => {
    assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, PROVIDERS.length)
    assert.equal(providerById('wellfound')?.domain, 'wellfound.com')
    assert.equal(providerById('nope'), undefined)
  })
})
