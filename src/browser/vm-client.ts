import { env } from '../config/env.js'
import { ApiError, notFound, serviceUnavailable } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import type { CookieRow } from './providers.js'

/**
 * The VM agent's HTTP surface, and nothing else.
 *
 * Every failure here becomes an `ApiError`. The first version threw a bare
 * `Error` with an ad-hoc `.status` property, which `normalise()` in
 * `src/middleware/error.ts` does not recognise — so a 409 "that browser is
 * already running", a 404, a bad token and a dropped SSH tunnel all reached the
 * browser as the same opaque "Something went wrong on our end." Four different
 * problems, four different fixes, one indistinguishable message.
 */

export interface VmConnectInfo {
  mode: 'connect'
  display: string
  vncPort: number
  pid: number | null
  expiresAt: string | null
}

export interface VmApplyInfo {
  mode: 'apply'
  cdpUrl: string
  pid: number | null
  expiresAt: string | null
}

export type VmMode = 'connect' | 'apply' | 'idle'

export interface VmTenantStatus {
  mode: VmMode
  pid: number | null
  uptimeMs: number
  profileBytes: number
}

/** The slot already has a browser running, and `currentMode` says which kind. */
export class VmAgentBusyError extends ApiError {
  constructor(readonly currentMode: VmMode) {
    super(409, 'browser_busy', `A browser is already running on this slot (${currentMode}).`)
    this.name = 'VmAgentBusyError'
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${env.VM_AGENT_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.VM_AGENT_TOKEN ?? ''}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(45_000),
    })
  } catch (error) {
    // In development the agent is reached over an SSH tunnel, and a dropped
    // tunnel looks exactly like a dead agent. Name the likely cause — this is
    // the failure a developer hits most and the one hardest to guess from a
    // connection-refused.
    logger.error({ err: error, path, agent: env.VM_AGENT_URL }, 'could not reach the VM agent')
    throw serviceUnavailable(
      'Cannot reach the browser host. Check the SSH tunnel to the VM (port 18900) is still up.',
    )
  }

  const body = (await response.json().catch(() => ({}))) as T & { error?: string; mode?: VmMode }
  if (response.ok) return body

  if (response.status === 409 && body.mode) throw new VmAgentBusyError(body.mode)
  if (response.status === 404) throw notFound('That browser slot does not exist on the host.')
  if (response.status === 401 || response.status === 403) {
    throw serviceUnavailable('The browser host rejected our credentials. Check VM_AGENT_TOKEN.')
  }
  throw new ApiError(
    response.status >= 500 ? 503 : response.status,
    'vm_agent_error',
    body.error ?? `The browser host returned ${response.status}.`,
  )
}

export function connectTenant(index: number): Promise<VmConnectInfo> {
  return call(`/tenants/${index}/connect`, { method: 'POST' })
}

export function applyTenant(index: number): Promise<VmApplyInfo> {
  return call(`/tenants/${index}/apply`, { method: 'POST' })
}

export function stopTenant(index: number): Promise<{ stopped: boolean }> {
  return call(`/tenants/${index}/stop`, { method: 'POST' })
}

export function disconnectTenant(index: number): Promise<{
  stopped: boolean
  cookieDomains: string[]
  /** `(host, name)` pairs. Names only — a value is the credential itself. */
  cookies?: CookieRow[]
}> {
  return call(`/tenants/${index}/disconnect`, { method: 'POST' })
}

export function getTenantCookies(index: number): Promise<{ domains: string[]; cookies?: CookieRow[] }> {
  return call(`/tenants/${index}/cookies`)
}

/** A PNG of the tenant's screen, or null when the host could not capture one. */
export async function getTenantScreenshot(index: number): Promise<Buffer | null> {
  try {
    const response = await fetch(`${env.VM_AGENT_URL}/tenants/${index}/screenshot`, {
      headers: { Authorization: `Bearer ${env.VM_AGENT_TOKEN ?? ''}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) return null
    return Buffer.from(await response.arrayBuffer())
  } catch (error) {
    logger.debug({ err: error, index }, 'could not capture the tenant screen')
    return null
  }
}

export function getTenantStatus(index: number): Promise<VmTenantStatus> {
  return call(`/tenants/${index}/status`)
}

export interface EnsureConnected {
  expiresAt: string | null
  /** `reused` means the user is returning to a window that was already open. */
  outcome: 'started' | 'reused' | 'replaced'
}

/**
 * Gets this slot into `connect` mode, whatever state it was in.
 *
 * The policy, in one place because every caller wants the same one:
 *
 * - already in `connect` → **reuse it**. A slot belongs to exactly one user, so
 *   "busy" here means *their own* window is still open. Reloading the page or
 *   coming back to a half-finished sign-in must land back in the same Chrome,
 *   with the same half-entered 2FA prompt, rather than failing.
 * - in any other mode → **close it, then start**. Closing goes through
 *   `disconnect` rather than a kill, because a graceful stop is what flushes
 *   cookies to disk, and those cookies are the entire asset.
 * - idle → start.
 */
export async function ensureTenantConnected(index: number): Promise<EnsureConnected> {
  try {
    const info = await connectTenant(index)
    return { expiresAt: info.expiresAt, outcome: 'started' }
  } catch (error) {
    if (!(error instanceof VmAgentBusyError)) throw error

    if (error.currentMode === 'connect') {
      const status = await getTenantStatus(index).catch(() => null)
      logger.info({ index, pid: status?.pid, uptimeMs: status?.uptimeMs }, 'reusing an open browser')
      return { expiresAt: null, outcome: 'reused' }
    }

    logger.info({ index, mode: error.currentMode }, 'closing a browser in the wrong mode before connecting')
    await disconnectTenant(index)
    const info = await connectTenant(index)
    return { expiresAt: info.expiresAt, outcome: 'replaced' }
  }
}
