import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertTenantCdpUrl, assertVmProfileOwner, parseVmProfile, selectBrowserProvider } from './profile-policy.js'

describe('VM profile routing and ownership', () => {
  it('routes a VM profile to VM even when the default is hosted', () => {
    assert.equal(selectBrowserProvider('vm:openclaw-vm:9', 'browser-use'), 'vm')
    assert.equal(selectBrowserProvider(null, 'browser-use'), 'browser-use')
  })
  it('rejects wrong hosts and indices rather than opening another profile', () => {
    assert.equal(parseVmProfile('vm:openclaw-vm:10', 'openclaw-vm'), 10)
    for (const id of ['vm:other:1', 'vm:openclaw-vm:11', 'vm:openclaw-vm:0', 'vm:openclaw-vm:01']) assert.throws(() => parseVmProfile(id, 'openclaw-vm'))
  })
  it('refuses another user profile or a removed connection', () => {
    const owner = { userId: 'a', vmId: 'host', tenantIndex: 9, status: 'ready' }
    assert.doesNotThrow(() => assertVmProfileOwner(owner, 'a', 'host', 9))
    assert.throws(() => assertVmProfileOwner(owner, 'b', 'host', 9))
    assert.throws(() => assertVmProfileOwner(undefined, 'a', 'host', 9))
    assert.throws(() => assertVmProfileOwner({ ...owner, status: 'absent' }, 'a', 'host', 9))
  })
  it('does not silently drop a hosted login into a local browser', () => {
    assert.throws(() => selectBrowserProvider('hosted-id', 'local'))
  })
})

it('only accepts the selected tenant loopback debugging endpoint', () => {
  assert.doesNotThrow(() => assertTenantCdpUrl('http://127.0.0.1:9209', 9))
  for (const url of ['http://127.0.0.1:9203', 'http://example.com:9209', 'https://127.0.0.1:9209', 'http://user:pass@127.0.0.1:9209']) assert.throws(() => assertTenantCdpUrl(url, 9))
})
