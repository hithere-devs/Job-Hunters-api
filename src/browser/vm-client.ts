import { env } from '../config/env.js'

export interface VmConnectInfo {
  mode: 'connect'
  display: string
  vncPort: number
  pid: number | null
  expiresAt: string | null
}

export interface VmSessionProfile {
  id: string
  vmId: string
  tenantIndex: number
  status: string
  cookieDomains: string[]
  lastVerifiedAt: string | null
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${env.VM_AGENT_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.VM_AGENT_TOKEN ?? ''}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw Object.assign(new Error(body.error ?? `VM agent returned ${response.status}`), { status: response.status })
  return body
}

export function connectTenant(index: number): Promise<VmConnectInfo> {
  return call(`/tenants/${index}/connect`, { method: 'POST' })
}

export function disconnectTenant(index: number): Promise<{ stopped: boolean; cookieDomains: string[] }> {
  return call(`/tenants/${index}/disconnect`, { method: 'POST' })
}

export function getTenantCookies(index: number): Promise<{ domains: string[] }> {
  return call(`/tenants/${index}/cookies`)
}

export function getTenantStatus(index: number): Promise<{ mode: 'connect' | 'idle'; pid: number | null; uptimeMs: number; profileBytes: number }> {
  return call(`/tenants/${index}/status`)
}
