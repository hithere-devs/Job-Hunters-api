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
  return when + 2_000 >= sinceMs
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

/**
 * The VM Chrome profile already has Gmail open.
 * Reuse that tab when it exists. Do not close it.
 */
export async function readGmailVerificationCode(page: Page, sinceMs = Date.now(), skipCodes?: Set<string>): Promise<string | null> {
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
    const search = mail.locator('input[aria-label*="Search" i], input[name="q"]').first()
    if (await search.count()) {
      await search.click({ timeout: 4_000 }).catch(() => undefined)
      await search.fill('newer_than:1h (from:greenhouse-mail.io OR from:greenhouse.io OR "8-character" OR "verification code" OR "confirm you\'re a human")')
      await search.press('Enter')
      await new Promise((resolve) => setTimeout(resolve, 2_200))
    }
    const rows = mail.locator('tr.zA, div[role="listitem"]')
    const n = Math.min(await rows.count().catch(() => 0), 8)
    for (let index = 0; index < n; index += 1) {
      const row = rows.nth(index)
      const titles = await row.locator('[title]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title') || '')).catch(() => [] as string[])
      if (!emailIsFromThisApply(titles, sinceMs)) {
        logger.info({ titles: titles.slice(0, 3) }, 'skip Greenhouse email older than this apply')
        continue
      }
      const preview = ((await row.innerText().catch(() => '')) || '').slice(0, 500)
      if (!OTP_MAIL.test(preview) && !extractGreenhouseEmailCode(preview)) continue
      await row.click({ timeout: 5_000 }).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 1_400))
      const body = await mail.locator('div.a3s, div[data-message-id], body').innerText().catch(() => '')
      const headerTitles = await mail.locator('span.g3[title], span[title*="202"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title') || '')).catch(() => [] as string[])
      if (headerTitles.length && !emailIsFromThisApply(headerTitles, sinceMs)) continue
      const code = extractGreenhouseEmailCode(body) ?? extractGreenhouseEmailCode(preview)
      if (!code) continue
      if (skipCodes?.has(code)) {
        logger.info({ digits: code.length }, 'newest Greenhouse code already tried; wait for a newer email')
        return null
      }
      logger.info({ digits: code.length, reusedTab: !opened }, 'read Gmail verification code')
      return code
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
