import { forbidden, serviceUnavailable } from '../lib/errors.js'

export function parseVmProfile(profileId: string, vmId: string): number {
  const match = /^vm:([^:]+):([1-9]|10)$/.exec(profileId)
  if (!match || match[1] !== vmId) throw serviceUnavailable('This browser profile belongs to an unavailable browser host.')
  return Number(match[2])
}

export function selectBrowserProvider(profileId: string | null | undefined, configured: 'vm' | 'local' | 'browser-use'): 'vm' | 'local' | 'browser-use' {
  if (profileId?.startsWith('vm:')) return 'vm'
  if (profileId && configured !== 'browser-use') throw serviceUnavailable('This profile requires its original browser provider. Reconnect it in browser setup.')
  return configured
}

export function assertVmProfileOwner(owner: { userId: string; vmId: string; tenantIndex: number; status: string } | undefined, userId: string | null, vmId: string, tenantIndex: number): void {
  if (!userId || !owner || owner.userId !== userId || owner.vmId !== vmId || owner.tenantIndex !== tenantIndex) throw forbidden('This browser profile does not belong to your account.')
  if (owner.status === 'absent' || owner.status === 'failed') throw serviceUnavailable('Reconnect your browser session before applying.')
}

export function assertTenantCdpUrl(raw: string, tenantIndex: number): void {
  let url: URL
  try { url = new URL(raw) } catch { throw serviceUnavailable('The browser host returned an invalid debugging endpoint.') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== String(9200 + tenantIndex) || url.username || url.password) throw serviceUnavailable('The browser host returned an unexpected debugging endpoint.')
}
