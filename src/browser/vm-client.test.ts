import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { ApiError } from '../lib/errors.js'
import { ensureTenantConnected, VmAgentBusyError } from './vm-client.js'

/**
 * What this guards against is a live failure, not a hypothetical one.
 *
 * The first version threw a bare `Error` carrying an ad-hoc `.status`, which
 * the error middleware does not recognise — so "your browser is already open"
 * reached the user as "Something went wrong on our end", and the connect page
 * sat on a black canvas because it never received a stream URL. Two invariants
 * come out of that: every failure here is an `ApiError` so its status survives,
 * and connecting twice is a reconnect rather than a conflict.
 */

const realFetch = globalThis.fetch

interface Reply {
  status: number
  body: unknown
}

/** Replies in order, and records the paths that were called. */
function stubAgent(replies: Reply[]): { calls: string[] } {
  const calls: string[] = []
  let index = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(new URL(String(input)).pathname)
    const reply = replies[index++] ?? { status: 500, body: { error: 'no reply queued' } }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  return { calls }
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('ensureTenantConnected', () => {
  it('starts a browser when the slot is idle', async () => {
    const { calls } = stubAgent([
      { status: 200, body: { mode: 'connect', display: ':11', vncPort: 6101, pid: 1, expiresAt: 'later' } },
    ])
    const result = await ensureTenantConnected(1)
    assert.equal(result.outcome, 'started')
    assert.equal(result.expiresAt, 'later')
    assert.deepEqual(calls, ['/tenants/1/connect'])
  })

  it('reuses a window that is already open rather than failing', async () => {
    // The exact sequence behind the reported bug: Chrome was already up from a
    // previous click, sitting on a half-finished 2FA prompt. Reloading the page
    // must land back in that same window, not 500 and not start a second one.
    const { calls } = stubAgent([
      { status: 409, body: { error: 'busy', mode: 'connect' } },
      { status: 200, body: { mode: 'connect', pid: 25237, uptimeMs: 453401, profileBytes: 1 } },
    ])
    const result = await ensureTenantConnected(1)
    assert.equal(result.outcome, 'reused')
    assert.deepEqual(calls, ['/tenants/1/connect', '/tenants/1/status'])
  })

  it('preserves an active application and returns its busy mode without stopping it', async () => {
    const { calls } = stubAgent([{ status: 409, body: { error: 'busy', mode: 'apply' } }])
    await assert.rejects(() => ensureTenantConnected(1), (error: unknown) => error instanceof VmAgentBusyError && error.status === 409 && error.currentMode === 'apply')
    assert.deepEqual(calls, ['/tenants/1/connect'])
  })

  it('does not reuse a browser that changed mode during reconnect', async () => {
    const { calls } = stubAgent([
      { status: 409, body: { error: 'busy', mode: 'connect' } },
      { status: 200, body: { mode: 'apply', pid: 2, uptimeMs: 1, profileBytes: 1 } },
    ])
    await assert.rejects(() => ensureTenantConnected(1), VmAgentBusyError)
    assert.deepEqual(calls, ['/tenants/1/connect', '/tenants/1/status'])
  })

  it('names the tunnel when the agent cannot be reached at all', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof globalThis.fetch
    await assert.rejects(
      () => ensureTenantConnected(1),
      (error: unknown) =>
        error instanceof ApiError && error.status === 503 && /SSH tunnel/.test(error.message),
    )
  })

  it('carries the current mode on a busy error', () => {
    const error = new VmAgentBusyError('connect')
    assert.equal(error.status, 409)
    assert.equal(error.currentMode, 'connect')
    assert.ok(error instanceof ApiError)
  })
})
