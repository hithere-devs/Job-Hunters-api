export class ExtensionProfileError extends Error {
  constructor(code, bootstrapAllowed = false) {
    super(code)
    this.name = 'ExtensionProfileError'
    this.code = code
    this.bootstrapAllowed = bootstrapAllowed
  }
}
const fail = (code, bootstrapAllowed = false) => { throw new ExtensionProfileError(code, bootstrapAllowed) }

/** Resolve only an already-running, gateway-owned extension relay.
 * Never starts Browser control, connects CDP, reads disk, or manufactures auth.
 * Call getBrowserControlState() fresh per tool. bootstrapAllowed permits only
 * a host-verified initial read-only snapshot, never raw-CDP mutation fallback.
 * cdpUrl is non-enumerable because it contains a process-only credential.
 */
export function resolveExtensionProfile({ state, resolveProfile, profileName, expectedPort }) {
  if (typeof profileName !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profileName) || !Number.isInteger(expectedPort) || expectedPort < 1024 || expectedPort > 65535 || typeof resolveProfile !== 'function') fail('extension_binding_invalid')
  if (state == null) fail('extension_runtime_unavailable', true)
  if (!state.resolved) fail('extension_runtime_invalid')
  const profile = resolveProfile(state.resolved, profileName)
  if (!profile || profile.name !== profileName || profile.driver !== 'extension' || profile.cdpPort !== expectedPort) fail('extension_profile_mismatch')
  let endpoint
  try { endpoint = new URL(profile.cdpUrl) } catch { fail('extension_endpoint_invalid') }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== expectedPort || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) fail('extension_endpoint_mismatch')
  const relay = state.extensionRelays instanceof Map ? state.extensionRelays.get(profileName) : undefined
  const runtime = state.profiles instanceof Map ? state.profiles.get(profileName) : undefined
  const token = state.resolved.extensionRelayInternalTokens?.[profileName]
  if (!relay) {
    const cleanBootstrap = !token && !endpoint.username && !endpoint.password && (!runtime || runtime.profile?.driver === 'extension' && runtime.profile.cdpPort === expectedPort)
    fail('extension_relay_not_owned_or_active', cleanBootstrap)
  }
  if (relay.port !== expectedPort || relay.ownership === 'borrowed' || runtime?.profile?.driver !== 'extension' || runtime.profile.cdpPort !== expectedPort) fail('extension_relay_not_owned_or_active')
  if (typeof token !== 'string' || !token || relay.internalToken !== token) fail('extension_internal_auth_unavailable')
  let password
  try { password = decodeURIComponent(endpoint.password) } catch { fail('extension_endpoint_invalid') }
  if (endpoint.username !== 'openclaw-internal' || password !== token) fail('extension_endpoint_mismatch')
  const result = { profileName, port: expectedPort }
  Object.defineProperty(result, 'cdpUrl', { value: profile.cdpUrl, enumerable: false, writable: false })
  return Object.freeze(result)
}
