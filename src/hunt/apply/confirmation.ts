import type { Page, Request } from 'playwright-core'
import { providerSubmissionBlocked, providerValidationFailed } from './provider-block.js'

/**
 * Deciding what a submit click did.
 *
 * The previous check tested `/thank you/` against the whole page body. Job
 * descriptions routinely end "Thank you for your interest in…", so a form could
 * be recorded as submitted before a single field was filled, and a click that
 * failed validation could be recorded as a success. Everything here is judged
 * on evidence that *changed* because of the click: the URL, the requests the
 * page sent, whether the form and its submit control are still there, and text
 * that was not on the page before.
 */

export type AtsFamily = 'greenhouse' | 'ashby' | 'lever' | 'smartrecruiters' | 'workable' | 'generic'

export type SubmitOutcome =
  /** Positive evidence the provider accepted the application. */
  | 'confirmed'
  /** Provably not accepted: the form is still there and it shows errors, or nothing left the browser. */
  | 'rejected_validation'
  /** The provider wants an emailed code before it accepts the application. */
  | 'verification_required'
  /** The provider refused it (spam flag). */
  | 'provider_blocked'
  /** A CAPTCHA challenge appeared instead of a submission: nothing was sent. */
  | 'captcha_required'
  /** Something was sent and the result is not observable. Never retry blindly. */
  | 'uncertain'

export interface PageState {
  url: string
  text: string
  formPresent: boolean
  submitVisible: boolean
  invalidCount: number
  errorTexts: string[]
  codeInputs: number
  /** A visible interactive CAPTCHA challenge (reCAPTCHA image grid, hCaptcha, Turnstile). */
  captchaChallenge?: boolean
}

export interface NetworkEvent {
  method: string
  url: string
  /** 0 while the response is still pending. */
  status: number
  sameSite: boolean
  applicationLike: boolean
}

export interface ClickEvidence {
  before: PageState
  after: PageState
  network: NetworkEvent[]
  ats: AtsFamily
}

export function atsFamily(url: string): AtsFamily {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return 'generic'
  }
  if (host.endsWith('greenhouse.io')) return 'greenhouse'
  if (host.endsWith('ashbyhq.com')) return 'ashby'
  if (host.endsWith('lever.co')) return 'lever'
  if (host.endsWith('smartrecruiters.com')) return 'smartrecruiters'
  if (host.endsWith('workable.com')) return 'workable'
  return 'generic'
}

/** Registrable-domain approximation: good enough to tell an ATS request from a CDN or captcha. */
export function siteOf(url: string): string {
  try {
    const labels = new URL(url).hostname.toLowerCase().split('.').filter(Boolean)
    if (labels.length <= 2) return labels.join('.')
    const twoPartTld = /^(?:co|com|net|org|gov|ac|edu)$/.test(labels[labels.length - 2]!) && labels[labels.length - 1]!.length === 2
    return labels.slice(twoPartTld ? -3 : -2).join('.')
  } catch {
    return ''
  }
}

const CONFIRM_URL: Record<AtsFamily, RegExp> = {
  greenhouse: /\/(?:confirmation|thanks|thank_you|application_confirmation)(?:[/?#]|$)|[?&]submitted=/i,
  lever: /\/thanks(?:[/?#]|$)/i,
  ashby: /\/application\/(?:success|submitted|thanks)(?:[/?#]|$)|[?&](?:submitted|success)=/i,
  smartrecruiters: /\/(?:confirmation|thank-?you|success)(?:[/?#]|$)/i,
  workable: /\/(?:success|thank-?you|confirmation)(?:[/?#]|$)/i,
  generic: /\/(?:confirmation|thank-?you|thanks|application-?(?:submitted|success|complete)|success)(?:[/?#]|$)/i,
}

export function confirmationUrl(url: string, ats: AtsFamily = atsFamily(url)): boolean {
  try {
    const parsed = new URL(url)
    return CONFIRM_URL[ats].test(`${parsed.pathname}${parsed.search}`)
  } catch {
    return false
  }
}

/**
 * What a provider says after accepting an application. Deliberately excludes
 * "thank you for your interest", which is how descriptions end, not how
 * confirmations read.
 */
export const CONFIRMATION_TEXT =
  /thank(?:s| you)(?: so much)? for (?:applying|your application|submitting(?: your application)?)|application (?:has been |was |is )?(?:successfully )?(?:submitted|received|sent|complete(?:d)?)\b|we(?:['’]ve| have) received your application|successfully (?:applied|submitted)|you(?:['’]ve| have) (?:successfully )?applied|your application is on its way|application submitted/i

const VERIFICATION_TEXT =
  /verification code was sent|enter the \d[- ]?character code|8-character code|security code to confirm|confirm you(?:['’]re| are) a human|we(?:['’]ve| have) sent (?:you )?a (?:verification |security )?code/i

const ERROR_TEXT =
  /\brequired\b|please (?:enter|select|complete|fill|provide|choose|upload|correct|fix)|is (?:invalid|not valid|too (?:short|long))|must (?:be|select|complete|fill|contain)|missing (?:entry|field)|can(?:no|')t be (?:blank|empty)|invalid (?:email|phone|format|value)|error processing/i

/** Lines present after the click that were not present before it. */
export function addedText(before: string, after: string): string {
  const seen = new Set(before.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean))
  return after
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !seen.has(line))
    .join('\n')
}

export function classifySubmitOutcome(evidence: ClickEvidence): { outcome: SubmitOutcome; reason: string } {
  const { before, after, network, ats } = evidence
  const fresh = addedText(before.text, after.text)
  if (providerSubmissionBlocked(after.text)) return { outcome: 'provider_blocked', reason: 'provider spam rejection shown' }

  const urlChanged = after.url !== before.url
  if (urlChanged && confirmationUrl(after.url, ats)) return { outcome: 'confirmed', reason: `confirmation URL ${new URL(after.url).pathname}` }

  const textConfirm = CONFIRMATION_TEXT.test(fresh)
  if (after.captchaChallenge && !textConfirm && !urlChanged) {
    return { outcome: 'captcha_required', reason: 'a CAPTCHA challenge appeared instead of a submission' }
  }
  const formGone = !after.formPresent || !after.submitVisible
  const mutations = network.filter((event) => event.sameSite && event.method !== 'GET')
  const accepted = mutations.some((event) => event.applicationLike && event.status >= 200 && event.status < 300)
  const refused = mutations.some((event) => event.status >= 400 && event.status < 500)
  const pending = mutations.some((event) => event.status === 0)

  if (textConfirm && (formGone || accepted)) return { outcome: 'confirmed', reason: 'confirmation text appeared after submit' }

  const verification = VERIFICATION_TEXT.test(fresh) || (after.codeInputs > before.codeInputs && after.codeInputs >= 1)
  if (verification && !textConfirm) return { outcome: 'verification_required', reason: 'provider asked for an emailed code' }

  const formStillThere = after.formPresent && after.submitVisible && !urlChanged
  // Greenhouse answers its own anti-abuse check with a 2xx and this banner; the
  // application was not taken.
  if (formStillThere && /error processing your application|could not (?:submit|process) your application|unable to submit (?:your )?application|something went wrong[^.\n]{0,60}try again/i.test(fresh)) {
    return { outcome: 'rejected_validation', reason: 'provider reported a processing error with the form still open' }
  }
  const errorsShown = after.invalidCount > before.invalidCount
    || after.errorTexts.some((text) => !before.errorTexts.includes(text) && ERROR_TEXT.test(text))
    || providerValidationFailed(fresh)
  if (formStillThere && (errorsShown || refused) && !accepted) {
    return { outcome: 'rejected_validation', reason: refused ? 'provider returned a 4xx for the submission' : 'validation errors shown on the form' }
  }
  if (formStillThere && mutations.length === 0) {
    // Every ATS submission is a request. None left the page, and the form is
    // still on screen: the click was swallowed by client-side validation.
    return { outcome: 'rejected_validation', reason: 'no request was sent and the form is still present' }
  }
  if (pending) return { outcome: 'uncertain', reason: 'submission request still pending' }
  if (accepted && formGone) return { outcome: 'uncertain', reason: 'request accepted and form closed, but no confirmation shown' }
  return { outcome: 'uncertain', reason: accepted ? 'request accepted but the form is still shown' : 'no positive confirmation signal' }
}

/** Snapshot of the evidence that a click can change. Runs entirely in the page. */
export async function capturePageState(page: Page, submitSelector: string): Promise<PageState> {
  const submitVisible = await page.locator(submitSelector).first().isVisible().catch(() => false)
  // No named functions inside evaluate: tsx/esbuild would inject a `__name`
  // helper that does not exist in the page. Visibility is inlined instead.
  const state = await page.evaluate(() => {
    const shown = new WeakSet<Element>()
    for (const node of Array.from(document.querySelectorAll('input, textarea, select, [role="alert"], [aria-live="assertive"], .error, .errors, .field-error, .error-message, [class*="error" i], [class*="invalid" i], [id*="error" i], [aria-invalid="true"]'))) {
      if (!(node instanceof HTMLElement)) continue
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const rect = node.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) shown.add(node)
    }
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="search"]), textarea, select'))
      .filter((node) => shown.has(node) || (node instanceof HTMLInputElement && ['radio', 'checkbox', 'file'].includes(node.type)))
    const errorNodes = Array.from(document.querySelectorAll('[role="alert"], [aria-live="assertive"], .error, .errors, .field-error, .error-message, [class*="error" i], [class*="invalid" i], [id*="error" i]'))
      .filter((node) => shown.has(node))
    const errorTexts: string[] = []
    for (const node of errorNodes) {
      const text = ((node as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim()
      if (text.length >= 3 && text.length <= 240 && !errorTexts.includes(text)) errorTexts.push(text)
      if (errorTexts.length >= 20) break
    }
    const invalidCount = Array.from(document.querySelectorAll('[aria-invalid="true"]')).filter((node) => shown.has(node) || node instanceof HTMLInputElement).length
    const codeInputs = Array.from(document.querySelectorAll('input[maxlength="1"], input[autocomplete="one-time-code"], input[aria-label*="security code" i], input[name*="security_code" i]'))
      .filter((node) => shown.has(node)).length
    // An interactive challenge frame that is actually on screen. The invisible
    // reCAPTCHA badge and a hidden challenge frame do not count.
    let captchaChallenge = false
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      const src = frame.getAttribute('src') || ''
      if (!/recaptcha\/(?:api2|enterprise)\/bframe|hcaptcha\.com\/.*(?:challenge|hcaptcha\.html#frame=challenge)|challenges\.cloudflare\.com/.test(src)) continue
      const rect = frame.getBoundingClientRect()
      if (rect.width < 100 || rect.height < 100) continue
      let hidden = false
      for (let node: Element | null = frame; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) { hidden = true; break }
      }
      if (!hidden) { captchaChallenge = true; break }
    }
    return {
      url: location.href,
      text: (document.body?.innerText || '').slice(0, 30_000),
      formPresent: inputs.length >= 2,
      invalidCount,
      errorTexts,
      codeInputs,
      captchaChallenge,
    }
  }).catch(() => ({ url: page.url(), text: '', formPresent: false, invalidCount: 0, errorTexts: [] as string[], codeInputs: 0, captchaChallenge: false }))
  return { ...state, submitVisible }
}

const MUTATION = new Set(['POST', 'PUT', 'PATCH'])
const APPLICATION_PATH = /apply|application|submit|graphql|candidate|posting|jobs?\/\d+|\/v\d+\//i

/** Records every same-site write the page makes while the click settles. */
export function watchSubmitNetwork(page: Page, formUrl: string): { pending(): number; stop(): NetworkEvent[] } {
  const site = siteOf(formUrl)
  const events = new Map<Request, NetworkEvent>()
  const onRequest = (request: Request) => {
    const method = request.method().toUpperCase()
    if (!MUTATION.has(method)) return
    const url = request.url()
    let path = ''
    try { path = new URL(url).pathname } catch { /* opaque */ }
    events.set(request, { method, url, status: 0, sameSite: siteOf(url) === site, applicationLike: APPLICATION_PATH.test(path) || request.isNavigationRequest() })
  }
  const onFinished = (request: Request) => {
    const event = events.get(request)
    if (!event) return
    void request.response().then((response) => { if (response) event.status = response.status() }).catch(() => undefined)
  }
  const onFailed = (request: Request) => {
    const event = events.get(request)
    if (event) event.status = -1
  }
  page.on('request', onRequest)
  page.on('requestfinished', onFinished)
  page.on('requestfailed', onFailed)
  return {
    pending() {
      return [...events.values()].filter((event) => event.sameSite && event.status === 0).length
    },
    stop() {
      page.off('request', onRequest)
      page.off('requestfinished', onFinished)
      page.off('requestfailed', onFailed)
      return [...events.values()]
    },
  }
}

/**
 * Wait until the click has visibly done something, then for its writes to finish.
 * Bounded: 15 s for a visible change, 8 s more for pending requests.
 */
export interface SettleTiming { visibleMs: number; writesMs: number; quietMs: number; pollMs: number }
const DEFAULT_SETTLE: SettleTiming = { visibleMs: 15_000, writesMs: 8_000, quietMs: 1_200, pollMs: 400 }

export async function settleAfterSubmit(page: Page, submitSelector: string, before: PageState, pendingWrites: () => number, timing: Partial<SettleTiming> = {}): Promise<PageState> {
  const t = { ...DEFAULT_SETTLE, ...timing }
  const changedBy = (state: PageState) => state.url !== before.url
    || !state.submitVisible
    || CONFIRMATION_TEXT.test(addedText(before.text, state.text))
    || VERIFICATION_TEXT.test(addedText(before.text, state.text))
    || state.invalidCount > before.invalidCount
    || state.errorTexts.length > before.errorTexts.length
    || providerSubmissionBlocked(state.text)
    || Boolean(state.captchaChallenge)
  let state = before
  const visibleDeadline = Date.now() + t.visibleMs
  while (Date.now() < visibleDeadline) {
    await new Promise((resolve) => setTimeout(resolve, t.pollMs))
    state = await capturePageState(page, submitSelector)
    if (changedBy(state)) break
  }
  const writeDeadline = Date.now() + t.writesMs
  while (pendingWrites() > 0 && Date.now() < writeDeadline) await new Promise((resolve) => setTimeout(resolve, Math.min(300, t.pollMs)))
  await new Promise((resolve) => setTimeout(resolve, t.quietMs))
  return capturePageState(page, submitSelector)
}

/**
 * Is the page *showing* a confirmation right now, independent of any click?
 * A live application form is never a confirmation, whatever its text says.
 */
export function pageShowsConfirmation(state: PageState): boolean {
  if (confirmationUrl(state.url)) return true
  if (state.formPresent && state.submitVisible) return false
  return CONFIRMATION_TEXT.test(state.text)
}
