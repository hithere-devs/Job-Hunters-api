import type { Page } from 'playwright-core'
import { logger } from '../../lib/logger.js'

const OTP_MAIL = /verification code|security code|one[- ]time|confirm you(?:['’]re| are) a human|8-character code|greenhouse/i
const JUNK_TOKEN = /^(?:security|character|continue|password|username|greenhouse|linkedin|mywritin|gmailcom|inboxnow|confirm|required|optional|thankyou|applynow|mailgoogle)$/i

/**
 * Pull the Greenhouse 8-character human-check code out of an email body.
 * In simple terms: find the short code in the message, not random Gmail words.
 */
export function extractGreenhouseEmailCode(text: string): string | null {
  const body = String(text ?? '').replace(/\u00a0/g, ' ')
  // "Copy and paste this code into the security code field on your application: KJKGrgxE."
  // Codes are often letters only, so the mixed-token fallback below misses them.
  const pasted = body.match(/(?:security code|verification code)[^:\n]{0,80}:\s*([A-Za-z0-9]{8})\b/i)
  if (pasted?.[1] && !JUNK_TOKEN.test(pasted[1])) return pasted[1]
  const labeled = body.match(/(?:verification code|security code|8-character code|your code is|code:)[^\nA-Za-z0-9]{0,48}([A-Za-z0-9]{8})\b/i)
  if (labeled?.[1] && !JUNK_TOKEN.test(labeled[1])) return labeled[1]
  const standalone = body.match(/(?:^|\n)\s*([A-Za-z0-9]{8})\s*(?:\n|$)/)
  if (standalone?.[1] && !JUNK_TOKEN.test(standalone[1])) return standalone[1]
  const tokens = body.match(/\b([A-Za-z0-9]{8})\b/g) ?? []
  const mixed = tokens.filter((token) => /[A-Za-z]/.test(token) && /\d/.test(token) && !JUNK_TOKEN.test(token))
  return mixed[0] ?? null
}

export function gmailTabAmong<T extends { url(): string }>(pages: T[]): T | undefined {
  return pages.find((tab) => /mail\.google\.com/i.test(tab.url()))
}

/** Parse a Gmail row/header time. Unknown stamps are not treated as new. */
export function gmailRowTimeMs(title: string, nowMs = Date.now()): number | null {
  const text = String(title ?? '').trim()
  if (!text) return null
  const parsed = Date.parse(text)
  if (Number.isFinite(parsed)) return parsed
  const clock = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\b/i)
  if (!clock) return null
  const noon = new Date(nowMs)
  let hour = Number(clock[1])
  const minute = Number(clock[2])
  const pm = /pm/i.test(clock[3] ?? '')
  if (hour === 12) hour = pm ? 12 : 0
  else if (pm) hour += 12
  noon.setHours(hour, minute, 0, 0)
  return noon.getTime()
}

export function emailIsFromThisApply(titles: string[], sinceMs: number, nowMs = Date.now()): boolean {
  const when = titles.map((title) => gmailRowTimeMs(title, nowMs)).find((stamp) => stamp != null)
  if (when == null) return false
  // Gmail shows times to the minute ("22:12"); a code sent at 22:12:55 for a
  // click at 22:12:50 reads as 22:12:00. Compare at minute precision.
  return when + 60_000 >= sinceMs
}

export function pageHasWrongSecurityCode(text: string): boolean {
  return /incorrect (?:security )?code|invalid (?:security )?code|wrong (?:security )?code|code (?:is|was) (?:incorrect|invalid|wrong|expired)|that code (?:is|was) (?:incorrect|invalid|wrong)|try (?:a |the )?(?:new|another) code|expired code|security code (?:is|was) (?:incorrect|invalid|wrong)/i.test(text)
}

export async function verificationInputsFilled(page: Page): Promise<boolean> {
  try {
    const boxes = page.locator('input[maxlength="1"], input[autocomplete="one-time-code"]')
    if (typeof (boxes as { nth?: unknown }).nth !== 'function') return false
    const count = await boxes.count().catch(() => 0)
    if (count >= 6) {
      let written = 0
      for (let index = 0; index < count; index += 1) {
        const value = await boxes.nth(index).inputValue().catch(() => '')
        if (String(value).trim()) written += 1
      }
      return written >= 6
    }
    const single = page.locator('input[maxlength="8"], input[name*="verif" i], input[id*="verif" i], input[aria-label*="security code" i]').first()
    if (typeof (single as { inputValue?: unknown }).inputValue !== 'function') return false
    const value = await single.inputValue().catch(() => '')
    return String(value).replace(/[^A-Za-z0-9]/g, '').length >= 6
  } catch {
    return false
  }
}

// Gmail keeps the inbox list in the DOM, hidden, while a search shows; only visible rows are results.
const VISIBLE_ROWS = 'tr.zA:visible, div[role="listitem"]:visible'

/** Company names as they appear in Greenhouse's subject line ("application to Chime Financial, Inc"). */
export function companyAliases(company: string | undefined): string[] {
  const full = (company ?? '').trim().toLowerCase()
  if (!full) return []
  const bare = full.replace(/,?\s+(?:inc|llc|ltd|gmbh|corp|co)\.?$/i, '').trim()
  return [...new Set([full, bare].filter((value) => value.length >= 2))]
}

/**
 * The newest code in a conversation, from messages sent after `sinceMs`.
 *
 * Gmail threads every "Security code for your application to X" email into one
 * conversation, and the list row shows neither the newest message's time nor
 * its snippet. Reading the row picked an older code (rejected as incorrect) or
 * skipped a fresh one as stale. Only the opened conversation is trustworthy.
 */
export function newestCodeIn(messages: Array<{ stamp: string; body: string }>, sinceMs: number, skip: Set<string> | undefined, nowMs = Date.now()): string | null {
  for (const message of [...messages].reverse()) {
    const at = gmailRowTimeMs(message.stamp, nowMs)
    // Minute precision: a code sent at 22:12:55 for a click at 22:12:50 reads 22:12.
    if (at == null || at + 60_000 < sinceMs) continue
    const code = extractGreenhouseEmailCode(message.body)
    if (code && !skip?.has(code)) return code
  }
  return null
}

/** Greenhouse names the employer in the subject: "Security code for your application to X". */
export function namesAnEmployer(subject: string): boolean {
  return /\bapplication to \S/i.test(subject)
}

async function conversationMessages(mail: Page): Promise<Array<{ stamp: string; body: string }>> {
  const expand = mail.locator('[aria-label="Expand all"]').first()
  if (await expand.isVisible().catch(() => false)) {
    await expand.click({ timeout: 3_000 }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  const messages = await mail.locator('div.adn').evaluateAll((nodes) => nodes.map((node) => ({
    stamp: node.querySelector('span.g3[title]')?.getAttribute('title') ?? '',
    body: (node.querySelector('div.a3s') as HTMLElement | null)?.innerText ?? '',
  }))).catch(() => [] as Array<{ stamp: string; body: string }>)
  if (messages.some((message) => message.stamp && message.body)) return messages
  // Older markup: pair stamps and bodies from the newest end.
  const stamps = await mail.locator('span.g3[title]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title') ?? '')).catch(() => [] as string[])
  const bodies = await mail.locator('div.a3s').allInnerTexts().catch(() => [] as string[])
  const count = Math.min(stamps.length, bodies.length)
  return Array.from({ length: count }, (_, index) => ({ stamp: stamps[stamps.length - count + index]!, body: bodies[bodies.length - count + index]! }))
}

async function searchMail(mail: Page, query: string): Promise<boolean> {
  // Navigate to the search instead of typing it: the search box's suggestion
  // dropdown stayed over the first result, so the click never opened it.
  // Re-running the same search does not refetch (the URL hash is unchanged),
  // so bounce through the inbox first.
  if (/#search\//.test(mail.url())) {
    await mail.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
  }
  await mail.goto(`https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined)
  await mail.locator(VISIBLE_ROWS).first().waitFor({ timeout: 10_000 }).catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 800))
  return /mail\.google\.com/.test(mail.url())
}

/**
 * The VM Chrome profile already has Gmail open.
 * Reuse that tab when it exists. Do not close it.
 */
export async function readGmailVerificationCode(page: Page, sinceMs = Date.now(), skipCodes?: Set<string>, options?: { company?: string; requireCompany?: boolean }): Promise<string | null> {
  const existing = typeof page.context === 'function' ? gmailTabAmong(page.context().pages()) : undefined
  const opened = !existing
  const mail = existing ?? await page.context().newPage()
  try {
    if (!/mail\.google\.com/i.test(mail.url())) {
      await mail.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'domcontentloaded', timeout: 45_000 })
    }
    await new Promise((resolve) => setTimeout(resolve, 1_800))
    const locked = /sign in|forgot email|enter your password/i.test(await mail.locator('body').innerText().catch(() => ''))
    if (locked && !/inbox|gmail/i.test(await mail.title().catch(() => ''))) {
      logger.info({ url: mail.url() }, 'Gmail tab is not signed in')
      return null
    }
    const aliases = companyAliases(options?.company)
    const senders = '(from:greenhouse-mail.io OR from:greenhouse.io OR "8-character" OR "verification code" OR "security code" OR "confirm you\'re a human")'
    // Search for this employer's email first: results are ordered by relevance, not time.
    const queries = [
      ...(aliases.length ? [`newer_than:1h ${senders} "${aliases[aliases.length - 1]}"`] : []),
      ...(options?.requireCompany && aliases.length ? [] : [`newer_than:1h ${senders}`]),
    ]
    for (const query of queries) {
      if (!await searchMail(mail, query)) break
      const rows = mail.locator(VISIBLE_ROWS)
      const n = Math.min(await rows.count().catch(() => 0), 6)
      const candidates: Array<{ index: number; named: boolean }> = []
      for (let index = 0; index < n; index += 1) {
        const preview = ((await rows.nth(index).innerText().catch(() => '')) || '').slice(0, 500)
        if (!OTP_MAIL.test(preview)) continue
        const lower = preview.toLowerCase()
        candidates.push({ index, named: aliases.some((alias) => lower.includes(alias)) })
      }
      for (const candidate of [...candidates.filter((row) => row.named), ...candidates.filter((row) => !row.named)]) {
        if (options?.requireCompany && aliases.length && !candidate.named) continue
        await mail.keyboard.press('Escape').catch(() => undefined)
        const opened = await rows.nth(candidate.index).click({ timeout: 5_000 }).then(() => true, (error: unknown) => {
          logger.info({ err: String(error).slice(0, 160) }, 'could not open the code email')
          return false
        })
        if (!opened) continue
        // The borrowed profile is cold-started per poll; Gmail can take a while to render.
        await mail.locator('div.a3s').first().waitFor({ timeout: 12_000 }).catch(() => undefined)
        // The list can re-render as mail arrives, shifting rows: trust the open conversation's subject.
        const subject = (await mail.locator('h2.hP').first().innerText({ timeout: 2_000 }).catch(() => '')).toLowerCase()
        const messages = await conversationMessages(mail)
        await mail.goBack({ timeout: 5_000 }).catch(() => undefined)
        await mail.locator(VISIBLE_ROWS).first().waitFor({ timeout: 5_000 }).catch(() => undefined)
        const matchedEmployer = aliases.some((alias) => subject.includes(alias))
        if (options?.requireCompany && aliases.length && !matchedEmployer) continue
        // "…your application to Klaviyo" is Klaviyo's code, never Coursera's: with
        // two applications waiting at once, the fallback handed each the other's.
        if (aliases.length && !matchedEmployer && namesAnEmployer(subject)) continue
        const code = newestCodeIn(messages, sinceMs, skipCodes)
        if (!code) {
          logger.info({ messages: messages.length, newest: messages.at(-1)?.stamp ?? null }, 'no unused code newer than this apply in the conversation')
          continue
        }
        logger.info({ digits: code.length, reusedTab: !opened, matchedEmployer, messages: messages.length }, 'read Gmail verification code')
        return code
      }
    }
    return null
  } catch (error) {
    logger.warn({ err: error }, 'Gmail code read failed')
    return null
  } finally {
    if (opened) await mail.close().catch(() => undefined)
  }
}

export async function fillVerificationCode(page: Page, code: string): Promise<boolean> {
  const chars = code.replace(/[^A-Za-z0-9]/g, '')
  if (chars.length < 6) return false
  const boxes = page.locator('input[maxlength="1"]')
  const count = await boxes.count().catch(() => 0)
  if (count >= 6) {
    await page.evaluate(() => {
      for (const input of Array.from(document.querySelectorAll('input[maxlength="1"]'))) {
        if (!(input instanceof HTMLInputElement)) continue
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }).catch(() => undefined)
    await boxes.nth(0).click({ timeout: 3_000 }).catch(() => undefined)
    await page.keyboard.type(chars, { delay: 80 }).catch(() => undefined)
    if (!await verificationInputsFilled(page)) {
      for (let index = 0; index < Math.min(count, chars.length); index += 1) {
        await boxes.nth(index).click({ timeout: 1_500 }).catch(() => undefined)
        await page.keyboard.type(chars[index] ?? '', { delay: 40 }).catch(() => undefined)
      }
    }
    await page.evaluate((value) => {
      const hidden = Array.from(document.querySelectorAll('input')).find((input) => {
        if (!(input instanceof HTMLInputElement)) return false
        const blob = `${input.name} ${input.id} ${input.getAttribute('aria-label') || ''} ${input.className}`
        return (input.type === 'hidden' || input.tabIndex < 0) && /security|verif|otp|human/i.test(blob)
      })
      if (hidden instanceof HTMLInputElement && hidden.value.replace(/[^A-Za-z0-9]/g, '').length < 6) {
        hidden.value = value
        hidden.dispatchEvent(new Event('input', { bubbles: true }))
        hidden.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }, chars).catch(() => undefined)
    const typed = await boxes.evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value).join('')).catch(() => '')
    if (typed !== chars) logger.warn({ typedLength: typed.length, sameIgnoringCase: typed.toLowerCase() === chars.toLowerCase() }, 'security code boxes do not hold the code that was typed')
    return verificationInputsFilled(page)
  }
  const single = page.locator('input[maxlength="8"], input[name*="verif" i], input[id*="verif" i], input[autocomplete="one-time-code"], input[aria-label*="security code" i]').first()
  if (await single.count()) {
    await single.click({ timeout: 2_000 }).catch(() => undefined)
    await single.pressSequentially(chars, { delay: 50 }).catch(async () => {
      await page.keyboard.type(chars, { delay: 50 }).catch(() => undefined)
    })
    const written = await single.inputValue().catch(() => '')
    if (String(written).replace(/[^A-Za-z0-9]/g, '').length >= 6) return true
  }
  await page.keyboard.type(chars, { delay: 40 }).catch(() => undefined)
  return verificationInputsFilled(page)
}

export async function completeGreenhouseEmailGate(
  page: Page,
  tries = 6,
  sinceMs = Date.now(),
  usedCodes?: Set<string>,
): Promise<boolean> {
  const used = usedCodes ?? new Set<string>()
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const body = await page.locator('body').innerText().catch(() => '')
    const mustRefetch = pageHasWrongSecurityCode(body) || used.size > 0
    if (!mustRefetch && await verificationInputsFilled(page)) return true
    const code = await readGmailVerificationCode(page, sinceMs, used)
    if (code && await fillVerificationCode(page, code)) {
      used.add(code)
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 8_000))
  }
  return verificationInputsFilled(page)
}
