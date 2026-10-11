import { and, eq } from 'drizzle-orm'
import { chromium, type Page } from 'playwright-core'
import { db } from '../../db/client.js'
import { emailAccounts, userBrowserSessions } from '../../db/schema.js'
import { accessTokenFor, textFrom } from '../../inbox/gmail.js'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { applyTenant, stopTenant, VmAgentBusyError } from '../../browser/vm-client.js'
import { extractGreenhouseEmailCode, readGmailVerificationCode } from './gmail-code.js'

/**
 * The emailed code some ATSs (Greenhouse, chiefly) demand after a submit.
 *
 * Sources, cheapest first:
 *   1. the Gmail API, when the user connected Gmail in the inbox feature;
 *   2. a Gmail tab in this same browser (signed-in VM profile sessions);
 *   3. the user's signed-in VM profile, borrowed briefly, when this
 *      application ran in a throwaway browser with no Gmail of its own.
 * Codes are polled until they arrive (they take seconds to a minute) and only
 * messages newer than the submit click are considered.
 */

const SENDERS = 'from:(greenhouse-mail.io OR greenhouse.io OR ashbyhq.com OR lever.co OR smartrecruiters.com OR workablemail.com)'
const SUBJECT_HINT = '("security code" OR "verification code" OR "8-character" OR "confirm you\'re a human" OR "one-time")'

async function codeFromGmailApi(userId: string, sinceMs: number, skip: Set<string>): Promise<string | null> {
  const [account] = await db.select({ status: emailAccounts.status, kind: emailAccounts.kind }).from(emailAccounts).where(eq(emailAccounts.userId, userId)).limit(1)
  if (!account || account.kind !== 'gmail-oauth' || account.status !== 'ready') return null
  const token = await accessTokenFor(userId)
  const query = `newer_than:1h ${SENDERS} ${SUBJECT_HINT}`
  const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=${encodeURIComponent(query)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
  if (!list.ok) return null
  const ids = ((await list.json()) as { messages?: Array<{ id: string }> }).messages ?? []
  for (const { id } of ids) {
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) continue
    const message = (await response.json()) as { internalDate?: string; snippet?: string; payload?: Parameters<typeof textFrom>[0] }
    if (Number(message.internalDate ?? 0) + 2_000 < sinceMs) continue
    const code = extractGreenhouseEmailCode(`${message.snippet ?? ''}\n${textFrom(message.payload)}`)
    if (code && !skip.has(code)) return code
  }
  return null
}

async function codeFromTenantProfile(userId: string, sinceMs: number, skip: Set<string>): Promise<string | null> {
  const [session] = await db.select({ vmId: userBrowserSessions.vmId, tenantIndex: userBrowserSessions.tenantIndex }).from(userBrowserSessions)
    .where(and(eq(userBrowserSessions.userId, userId), eq(userBrowserSessions.vmId, env.VM_ID))).limit(1)
  if (!session || !env.VM_AGENT_URL) return null
  let started = false
  try {
    const info = await applyTenant(session.tenantIndex)
    started = true
    const browser = await chromium.connectOverCDP(info.cdpUrl, { timeout: 30_000 })
    try {
      const context = browser.contexts()[0] ?? await browser.newContext()
      const page = context.pages()[0] ?? await context.newPage()
      const code = await readGmailVerificationCode(page, sinceMs, skip)
      return code
    } finally {
      await browser.close().catch(() => undefined)
    }
  } catch (error) {
    // Busy (the user is signing in, or another application holds it): try again on the next poll.
    if (!(error instanceof VmAgentBusyError)) logger.warn({ err: error }, 'could not read the verification code from the signed-in profile')
    return null
  } finally {
    if (started) await stopTenant(session.tenantIndex).catch(() => undefined)
  }
}

export async function readVerificationCode(params: {
  userId: string
  page: Page
  /** The submit click that triggered the email. */
  sinceMs: number
  /** True when `page` runs in the user's own signed-in profile. */
  pageHasMailbox: boolean
  /** Lets the caller lease the profile before borrowing it; null means it is unavailable. */
  borrowProfile?: (<T>(work: () => Promise<T>) => Promise<T | null>) | null
  skip?: Set<string>
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<string | null> {
  const skip = params.skip ?? new Set<string>()
  const deadline = Date.now() + (params.timeoutMs ?? 120_000)
  let tenantTried = 0
  while (Date.now() < deadline) {
    params.signal?.throwIfAborted()
    const fromApi = await codeFromGmailApi(params.userId, params.sinceMs, skip).catch((error: unknown) => {
      logger.debug({ err: error }, 'Gmail API code lookup failed')
      return null
    })
    if (fromApi) return fromApi
    if (params.pageHasMailbox) {
      const fromTab = await readGmailVerificationCode(params.page, params.sinceMs, skip)
      if (fromTab) return fromTab
    } else if (params.borrowProfile && tenantTried < 4) {
      tenantTried += 1
      const borrowed = await params.borrowProfile(() => codeFromTenantProfile(params.userId, params.sinceMs, skip)).catch(() => null)
      if (borrowed) return borrowed
    }
    await new Promise((resolve) => setTimeout(resolve, 6_000))
  }
  return null
}
