import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveExtensionProfile } from './extension-profile.mjs'
const profileName = 'extension-test', port = 27801, token = 'fixture-internal:/value'
function fixture() {
  const profile = { name: profileName, driver: 'extension', cdpPort: port, cdpUrl: `http://openclaw-internal:${encodeURIComponent(token)}@127.0.0.1:${port}` }
  const state = { resolved: { extensionRelayInternalTokens: { [profileName]: token } }, extensionRelays: new Map([[profileName, { port, ownership: 'owned', internalToken: token }]]), profiles: new Map([[profileName, { profile }]]) }
  return { state, resolveProfile: () => profile, profileName, expectedPort: port, profile }
}
test('uses the exact gateway-owned in-process auth URL without exposing it to JSON logs', () => {
  const args = fixture(), result = resolveExtensionProfile(args)
  assert.equal(result.cdpUrl, args.profile.cdpUrl)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { profileName, port })
  assert.equal(Object.isFrozen(result), true)
})
test('missing browser runtime or relay refuses mutation rather than falling back to raw CDP', () => {
  assert.throws(() => resolveExtensionProfile({ ...fixture(), state: null }), /runtime_unavailable/)
  const args = fixture(); args.state.extensionRelays.clear()
  assert.throws(() => resolveExtensionProfile(args), /not_owned_or_active/)
})
test('wrong profile, driver, or per-tenant relay port is rejected', () => {
  for (const change of [{ name: 'another' }, { driver: 'openclaw' }, { cdpPort: 20801 }]) {
    const args = fixture(); Object.assign(args.profile, change)
    assert.throws(() => resolveExtensionProfile(args), /profile_mismatch/)
  }
})
test('borrowed or stale relay authentication cannot inherit another runtime credential', () => {
  for (const change of [{ ownership: 'borrowed' }, { internalToken: 'stale' }, { port: 20801 }]) {
    const args = fixture(); Object.assign(args.state.extensionRelays.get(profileName), change)
    assert.throws(() => resolveExtensionProfile(args), /not_owned_or_active|internal_auth_unavailable/)
  }
})
test('public host, altered username/password, path, query and websocket URLs fail closed', () => {
  for (const cdpUrl of [`http://openclaw-internal:${encodeURIComponent(token)}@example.com:${port}`, `http://other:${encodeURIComponent(token)}@127.0.0.1:${port}`, `http://openclaw-internal:wrong@127.0.0.1:${port}`, `http://openclaw-internal:${encodeURIComponent(token)}@127.0.0.1:${port}/cdp`, `http://openclaw-internal:${encodeURIComponent(token)}@127.0.0.1:${port}?token=x`, `ws://openclaw-internal:${encodeURIComponent(token)}@127.0.0.1:${port}`]) {
    const args = fixture(); args.profile.cdpUrl = cdpUrl
    assert.throws(() => resolveExtensionProfile(args), /endpoint_mismatch/)
  }
})
test('only genuinely unstarted runtime or clean relay configuration permits read-only bootstrap', () => {
  assert.throws(() => resolveExtensionProfile({ ...fixture(), state: null }), error => error.bootstrapAllowed === true)
  const clean = fixture(); clean.state.extensionRelays.clear(); clean.state.profiles.clear(); clean.state.resolved.extensionRelayInternalTokens = {}; clean.profile.cdpUrl = `http://127.0.0.1:${port}`
  assert.throws(() => resolveExtensionProfile(clean), error => error.bootstrapAllowed === true)
  const stale = fixture(); stale.state.extensionRelays.clear()
  assert.throws(() => resolveExtensionProfile(stale), error => error.bootstrapAllowed === false)
  const wrong = fixture(); wrong.profile.cdpPort = 20801
  assert.throws(() => resolveExtensionProfile(wrong), error => error.bootstrapAllowed === false)
  const publicHost = fixture(); publicHost.state.extensionRelays.clear(); publicHost.profile.cdpUrl = `http://example.com:${port}`
  assert.throws(() => resolveExtensionProfile(publicHost), error => error.bootstrapAllowed === false)
})
