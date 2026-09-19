import type { Page } from 'playwright-core'
import type { FormField } from './fields.js'

/**
 * Reading a form, and the per-portal knowledge that makes it reliable.
 *
 * Generic heuristics get an application most of the way on most forms and then
 * fail on the last field, which is the same as failing entirely. Greenhouse,
 * Lever, Ashby, SmartRecruiters, and Workable carry the majority of
 * engineering applications Huntly discovers, and they have stable markup — so
 * they get real recipes, and that is where submission success actually comes
 * from.
 *
 * Aggregators (Remotive, Jobicy, RemoteOK, We Work Remotely, Arbeitnow) land
 * on one of those hosts after navigation. Instahyre stays behind a portal
 * account. Everything else falls back to the generic reader.
 */

/** Ashby CSS-module fieldsets often drop `ashby-application-form-field-entry`. */
export const ASHBY_FIELD_ENTRY_SEL =
  '.ashby-application-form-field-entry, [data-field-entry-id], fieldset[class*="fieldEntry"], .application-question'

export interface Recipe {
  id: string
  /** Hosts this recipe applies to. */
  matches: (host: string) => boolean
  /** Where the apply form lives, when it is behind a button. */
  openForm?: (page: Page) => Promise<void>
  /** Selector for the field containers, so labels pair with inputs correctly. */
  fieldContainer: string
  /**
   * The control that submits. Never clicked in dry-run mode.
   *
   * Match on the button's *words*, never on `type="submit"`. Every one of
   * these platforms puts several submit-typed buttons on the form — Ashby's
   * application page has eight, including "Upload file" and a pair of
   * Yes/No answers, and Lever's only submit-typed buttons belong to the
   * cookie banner. A generic selector plus `.first()` clicks whichever comes
   * first in the DOM, which is not the one that sends the application.
   *
   * `:has-text()` rather than `:text-matches()`: the latter matches only the
   * smallest element holding the text, so it missed Ashby's button, which
   * wraps its label in a span.
   */
  submit: string
  /** Text that means it worked. */
  success: RegExp
}

/**
 * Some company career sites embed the real Greenhouse application in a
 * cross-origin iframe. Move the owned browser tab to that verified form URL so
 * both the deterministic reader and the guarded reasoning driver can inspect
 * it as a normal top-level document.
 */
export function embeddedGreenhouseApplicationUrl(src: string | null): string | null {
  if (!src) return null
  try {
    const url = new URL(src)
    if (url.protocol !== 'https:') return null
    if (!['job-boards.greenhouse.io', 'boards.greenhouse.io'].includes(url.hostname.toLowerCase())) return null
    if (!/^\/embed\/job_app\/?$/i.test(url.pathname)) return null
    return url.toString()
  } catch {
    return null
  }
}

/** Greenhouse board token plus job id, e.g. `elastic:8154997`. */
export function greenhouseJobBoardUrl(sourceId: string | null | undefined): string | null {
  const match = /^([a-z0-9-]+):(\d+)$/i.exec(sourceId?.trim() ?? '')
  if (!match) return null
  return `https://job-boards.greenhouse.io/${match[1]}/jobs/${match[2]}`
}

export function greenhouseJobPathUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (!(host === 'job-boards.greenhouse.io' || host === 'boards.greenhouse.io' || host.endsWith('.greenhouse.io'))) {
      return false
    }
    if (/\/jobs\/\d+/.test(parsed.pathname)) return true
    return /^\/embed\/job_app\/?$/i.test(parsed.pathname)
      && Boolean(parsed.searchParams.get('for'))
      && /^\d+$/.test(parsed.searchParams.get('token') ?? '')
  } catch {
    return false
  }
}

/** Greenhouse `for` + job id as a top-level application form, not a career listing. */
export function greenhouseEmbedApplicationUrl(sourceId: string | null | undefined): string | null {
  const match = /^([a-z0-9-]+):(\d+)$/i.exec(sourceId?.trim() ?? '')
  const token = match?.[1]
  const jobId = match?.[2]
  if (!token || !jobId) return null
  return `https://job-boards.greenhouse.io/embed/job_app?for=${token.toLowerCase()}&token=${jobId}`
}

/** Closed or unknown Greenhouse job. Board and embed both land on `error=true`. */
export function greenhousePostingGoneUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (!(host === 'job-boards.greenhouse.io' || host === 'boards.greenhouse.io' || host.endsWith('.greenhouse.io'))) {
      return false
    }
    return parsed.searchParams.get('error') === 'true'
  } catch {
    return false
  }
}

/** Greenhouse token plus job id from a `gh_jid` career-site listing. */
export function greenhouseFromListingUrl(url: string | null | undefined, sourceId?: string | null): string | null {
  const fromSource = greenhouseJobBoardUrl(sourceId)
  if (fromSource) return fromSource
  if (!url) return null
  try {
    const parsed = new URL(url)
    const jobId = parsed.searchParams.get('gh_jid')
    if (!jobId || !/^\d+$/.test(jobId)) return null
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase()
    const token = (sourceId?.split(':')[0]
      || /^jobs\.([a-z0-9-]+)\./i.exec(host)?.[1]
      || host.split('.')[0]
    )?.toLowerCase()
    if (!token || token === 'www') return null
    return `https://job-boards.greenhouse.io/${token}/jobs/${jobId}`
  } catch {
    return null
  }
}

/** Prefer a Greenhouse job-board form URL over a custom-domain listing. */
export function resolveApplyUrl(input: {
  jobApplyUrl?: string | null
  sourceApplyUrl?: string | null
  canonicalUrl?: string | null
  sourceId?: string | null
}): string {
  const board = greenhouseEmbedApplicationUrl(input.sourceId)
    || greenhouseJobBoardUrl(input.sourceId)
    || greenhouseFromListingUrl(input.jobApplyUrl, input.sourceId)
    || greenhouseFromListingUrl(input.sourceApplyUrl, input.sourceId)
    || greenhouseFromListingUrl(input.canonicalUrl, input.sourceId)
  const candidates = [board, input.jobApplyUrl, input.sourceApplyUrl, input.canonicalUrl].filter((value): value is string => Boolean(value?.trim()))
  const greenhouseJob = candidates.find((value) => greenhouseJobPathUrl(value))
  return (greenhouseJob ?? candidates[0] ?? '').trim()
}

/** Wait for Greenhouse to either show the form or bounce to error=true. */
export async function waitForGreenhouseSettle(page: Page): Promise<void> {
  const url = page.url()
  if (!(greenhouseJobPathUrl(url) || embeddedGreenhouseApplicationUrl(url) || greenhousePostingGoneUrl(url))) return
  if (greenhousePostingGoneUrl(url)) return
  await Promise.race([
    page.waitForURL((next) => greenhousePostingGoneUrl(next.toString()), { timeout: 8_000 }),
    page.waitForSelector('#application_form, form#application-form, .field-wrapper, input[type="file"], #submit_app', { timeout: 8_000 }),
  ]).catch(() => undefined)
}

export async function openEmbeddedApplication(page: Page): Promise<string | null> {
  if (greenhousePostingGoneUrl(page.url())) return null
  if (greenhouseJobPathUrl(page.url()) || embeddedGreenhouseApplicationUrl(page.url())) {
    await waitForGreenhouseSettle(page)
    return page.url()
  }
  const iframe = page.locator('iframe#grnhse_iframe, iframe[title*="Greenhouse" i]').first()
  // The iframe starts below the fold and some sites report it as non-visible
  // until the user scrolls. Its verified HTTPS source is the security boundary;
  // viewport visibility is not required before navigating to that source.
  await iframe.waitFor({ state: 'attached', timeout: 15_000 }).catch(() => undefined)
  if ((await iframe.count()) === 0) return null
  let url: string | null = null
  for (let attempt = 0; attempt < 20 && !url; attempt += 1) {
    url = embeddedGreenhouseApplicationUrl(await iframe.getAttribute('src'))
    if (!url) await page.waitForTimeout(250)
  }
  if (!url) return null
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await waitForGreenhouseSettle(page)
  return page.url()
}

/** Provider markup sometimes gives a consent checkbox the preceding upload label. */
export function correctedFieldLabel(field: FormField): string {
  if (field.type === 'checkbox' && /(?:gdpr|privacy|data).*consent|consent.*(?:gdpr|privacy|data)/i.test(field.name ?? '')) {
    return 'Consent to processing applicant data'
  }
  return field.label
}

/** Placeholder text is not a question. Strip it so comboboxes keep the real label. */
export function cleanFieldLabel(label: string): string {
  return label
    .replace(/start typing\.\.\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isYesNoOptionLabel(label: string): boolean {
  return /^(?:yes|no)\b/i.test(label.trim())
}

export function optionGroupTopic(label: string): 'sms' | 'whatsapp' | 'consent' | null {
  if (/\b(?:sms|text\s+messages?)\b/i.test(label)) return 'sms'
  if (/\bwhatsapp\b/i.test(label)) return 'whatsapp'
  if (isYesNoOptionLabel(label) && /\bconsent\b/i.test(label)) return 'consent'
  return null
}

const OPTION_GROUP_LABEL: Record<'sms' | 'whatsapp' | 'consent', string> = {
  sms: 'SMS text message consent',
  whatsapp: 'WhatsApp message consent',
  consent: 'Consent',
}

/**
 * Ashby often renders each Yes/No choice as its own field labelled with the
 * option text. Those are one question. Merge consecutive matching options so
 * consent heuristics and radio fill see a single control.
 */
export function coalesceOptionFields(fields: FormField[]): FormField[] {
  const out: FormField[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!
    const topic = optionGroupTopic(field.label)
    if (!topic || !isYesNoOptionLabel(field.label)) {
      out.push(field)
      continue
    }
    const group = [field]
    let nextIndex = index + 1
    while (nextIndex < fields.length) {
      const next = fields[nextIndex]!
      if (optionGroupTopic(next.label) !== topic || !isYesNoOptionLabel(next.label)) break
      group.push(next)
      nextIndex += 1
    }
    if (group.length < 2) {
      out.push(field)
      continue
    }
    out.push({
      fid: group[0]?.fid,
      label: OPTION_GROUP_LABEL[topic],
      type: 'radio',
      name: group.find((item) => item.name)?.name,
      required: group.some((item) => item.required),
      options: group.map((item) => item.label.replace(/\s+/g, ' ').trim()),
    })
    index = nextIndex - 1
  }
  return out
}

/**
 * The generic reader.
 *
 * Runs in the page so it can walk the DOM once rather than round-tripping per
 * element. Pairs each control with its label the way a person would: an
 * explicit `for=`, then a wrapping label, then `aria-label`, then the nearest
 * preceding text.
 */
export async function readFields(page: Page, containerSelector?: string): Promise<FormField[]> {
  // Written as one flat loop with no inner function declarations on purpose.
  // esbuild — which `tsx` uses in development — injects a `__name` helper for
  // named function expressions, and that helper does not exist inside the
  // page. The result is `ReferenceError: __name is not defined` in dev and
  // silence under `tsc`, which is the worst kind of difference to debug.
  const fields = await page.evaluate(({ selector, entrySel }) => {
    const scope: ParentNode = selector ? (document.querySelector(selector) ?? document) : document
    const controls = Array.from(scope.querySelectorAll<HTMLElement>('input, select, textarea'))
    const found: Array<{
      label: string
      type: string
      name?: string
      required: boolean
      options?: string[]
    }> = []
    const covered: HTMLElement[] = []
    const processedEntries: Element[] = []

    const entries: Element[] = []
    const allEntries = Array.from(scope.querySelectorAll(entrySel))
    for (const entry of allEntries) {
      if (entry.parentElement && entry.parentElement.closest(entrySel)) continue
      entries.push(entry)
    }
    for (const entry of entries) {
      const style = getComputedStyle(entry)
      if (style.display === 'none' || style.visibility === 'hidden' || (entry instanceof HTMLElement && entry.hidden)) continue
      const hasWidget = entry.querySelector('input, select, textarea, [contenteditable="true"], [role="combobox"], .ashby-application-form-input-yesno')
      const rect = entry.getBoundingClientRect()
      if (!hasWidget && (!rect.width || !rect.height)) continue
      let label = ''
      const labelNodes = Array.from(entry.querySelectorAll('label'))
      for (let i = 0; i < labelNodes.length; i++) {
        const node = labelNodes[i]!
        if (node.closest('.ashby-application-form-input-yesno')) continue
        const raw = (node.textContent ?? '').replace(/start typing\.\.\.?/gi, ' ').replace(/\s+/g, ' ').trim()
        if (raw.length > 1) { label = raw; break }
      }
      if (!label) {
        const chunks = Array.from(entry.querySelectorAll('legend, [class*="question"], [class*="Question"], [class*="label"], [class*="Label"], p, h2, h3, h4, span, div'))
        for (let i = 0; i < chunks.length; i++) {
          const node = chunks[i]!
          if (node.querySelector('input, select, textarea, button, [contenteditable="true"]')) continue
          const raw = (node.textContent ?? '').replace(/start typing\.\.\.?/gi, ' ').replace(/\s+/g, ' ').trim()
          if (raw.length > 5 && !/^(yes|no)$/i.test(raw)) { label = raw; break }
        }
      }
      if (!label || /^start typing/i.test(label)) {
        label = (entry.textContent ?? '').replace(/start typing\.\.\.?/gi, ' ').replace(/\s+/g, ' ').trim()
      }
      if (!label) continue
      label = label.replace(/\s+/g, ' ').slice(0, 200)
      const yesno = entry.querySelector('.ashby-application-form-input-yesno')
      const combo = entry.querySelector<HTMLInputElement>('input[role="combobox"], input.ashby-application-form-input-autocomplete')
      const file = entry.querySelector<HTMLInputElement>('input[type="file"]')
      const select = entry.querySelector('select')
      const textarea = entry.querySelector('textarea')
      const editable = entry.querySelector<HTMLElement>('[contenteditable="true"]')
      const radios = Array.from(entry.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
      const checks = Array.from(entry.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).filter((box) => {
        if (box.closest('.ashby-application-form-input-yesno')) return false
        const style = getComputedStyle(box)
        return style.display !== 'none' && style.visibility !== 'hidden'
      })
      const text = entry.querySelector<HTMLInputElement>('input:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"]):not([type="password"])')
      const required = /(?:[✱*]|\(required\))\s*$/i.test(label)
        || entry.querySelector('[required], [aria-required="true"], [class*="_required_"]') !== null
        || /\b(?:how|where)\s+did\s+you\s+(?:hear|learn|find)/i.test(label)
      let pushed = false
      if (yesno) {
        const options = Array.from(yesno.querySelectorAll('button')).map((button) => (button.textContent ?? '').trim()).filter((item) => /^(yes|no)$/i.test(item))
        if (options.length === 2) {
          found.push({ label, type: 'checkbox', required, options: ['Yes', 'No'] })
          pushed = true
        }
      } else if (combo) {
        found.push({ label, type: 'combobox', name: combo.getAttribute('name') ?? undefined, required: required || combo.required || combo.getAttribute('aria-required') === 'true' })
        pushed = true
      } else if (file) {
        found.push({ label, type: 'file', name: file.getAttribute('name') ?? undefined, required: required || file.required })
        pushed = true
      } else if (select instanceof HTMLSelectElement) {
        const options: string[] = []
        for (const option of Array.from(select.options)) options.push(option.label || option.value)
        found.push({ label, type: select.multiple ? 'select-multiple' : 'select-one', name: select.name || undefined, required: required || select.required, options })
        pushed = true
      } else if (radios.length) {
        const options: string[] = []
        for (const radio of radios) {
          const id = radio.getAttribute('id')
          const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() ?? '' : ''
          const wrap = radio.closest('label')?.textContent?.trim() ?? ''
          const option = (forLabel || wrap || radio.value || '').replace(/start typing\.\.\.?/gi, ' ').replace(/\s+/g, ' ').trim()
          if (option && option !== label) options.push(option.slice(0, 120))
          else if (option) options.push(option.slice(0, 120))
        }
        found.push({ label, type: 'radio', name: radios[0]?.name || undefined, required: required || radios.some((radio) => radio.required), options })
        pushed = true
      } else if (textarea || editable) {
        found.push({ label, type: 'textarea', name: textarea?.name || undefined, required: required || Boolean(textarea?.required) })
        pushed = true
      } else if (checks.length > 1) {
        const options: string[] = []
        for (const box of checks) {
          const id = box.getAttribute('id')
          const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() ?? '' : ''
          const wrap = box.closest('label')?.textContent?.trim() ?? ''
          const option = (forLabel || wrap || box.value || '').replace(/\s+/g, ' ').trim()
          if (option) options.push(option.slice(0, 120))
        }
        found.push({ label, type: 'checkbox', name: checks[0]?.name || undefined, required, options })
        pushed = true
      } else if (text && text !== combo) {
        found.push({ label, type: text.type || 'text', name: text.name || undefined, required: required || text.required || text.getAttribute('aria-required') === 'true' })
        pushed = true
      } else if (checks.length === 1) {
        found.push({ label, type: 'checkbox', name: checks[0]?.name || undefined, required: required || Boolean(checks[0]?.required) })
        pushed = true
      }
      if (!pushed) continue
      processedEntries.push(entry)
      const nestedEntries = entry.querySelectorAll(entrySel)
      for (let n = 0; n < nestedEntries.length; n++) processedEntries.push(nestedEntries[n]!)
      const inner = Array.from(entry.querySelectorAll<HTMLElement>('input, select, textarea, [contenteditable="true"]'))
      for (const node of inner) covered.push(node)
    }

    for (const element of controls) {
      if (covered.includes(element)) continue
      const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      const type = (input as HTMLInputElement).type || input.tagName.toLowerCase()
      if (['hidden','password'].includes(type) || input.disabled || /^(current-password|new-password|one-time-code)$/.test(input.getAttribute('autocomplete') ?? '')) continue
      if (element.closest('.ashby-application-form-input-yesno')) continue
      // Conditional sections are not questions until the provider shows them.
      // Do not mistake a visually hidden native radio for a hidden question.
      let hiddenAncestor = false
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        if (parent.hidden || parent.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') { hiddenAncestor = true; break }
      }
      if (hiddenAncestor) continue
      if (!['radio','checkbox'].includes(type)) {
        const style = getComputedStyle(element)
        if (element.hidden || element.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') continue
      }


      // Pair the control with its label the way a person would: an explicit
      // `for=`, then a wrapping label, then aria, then nearby text.
      let label = ''
      const id = element.getAttribute('id')
      if (id) {
        const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`)
        if (explicit && explicit.textContent && explicit.textContent.trim()) {
          label = explicit.textContent.trim()
        }
      }
      if (!label) {
        const wrapping = element.closest('label')
        if (wrapping && wrapping.textContent && wrapping.textContent.trim()) {
          label = wrapping.textContent.trim()
        }
      }
      if (!label) {
        const aria = element.getAttribute('aria-label')
        if (aria && aria.trim()) label = aria.trim()
      }
      if (!label) {
        const labelledBy = element.getAttribute('aria-labelledby')
        if (labelledBy) {
          const target = document.getElementById(labelledBy.split(/\s+/)[0] ?? labelledBy)
          if (target && target.textContent && target.textContent.trim()) {
            label = target.textContent.trim()
          }
        }
      }
      if (!label) {
        const container = element.closest('div, fieldset, li, section')
        const text = container
          ? container.querySelector('label, legend, .label, [class*="label"]')
          : null
        if (text && text.textContent && text.textContent.trim()) label = text.textContent.trim()
      }
      if (!label) {
        const placeholder = element.getAttribute('placeholder')
        const entry = element.closest(entrySel) || element.closest('fieldset')
        const entryLabel = (entry?.querySelector('label, .ashby-application-form-question-title')?.textContent ?? '').replace(/start typing\.\.\.?/gi, ' ').replace(/\s+/g, ' ').trim()
        if (entryLabel) label = entryLabel
        else if (placeholder && placeholder.trim() && !/^start typing/i.test(placeholder.trim())) label = placeholder.trim()
        else label = element.getAttribute('name') || ''
      }
      label = label.replace(/start typing\.\.\.?/gi, ' ').replace(/\s+/g, ' ').trim()
      if (!label) continue
      if (type === 'text' && (element.getAttribute('role') === 'combobox' || /autocomplete/i.test(element.className))) {
        const entry = element.closest(entrySel) || element.closest('fieldset')
        found.push({
          label: label.replace(/\s+/g, ' ').slice(0, 200),
          type: 'combobox',
          name: input.getAttribute('name') ?? undefined,
          required: input.required || element.getAttribute('aria-required') === 'true' || /(?:[✱*]|\(required\))\s*$/i.test(label) || entry?.querySelector('[class*="_required_"]') !== null || /\b(?:how|where)\s+did\s+you\s+(?:hear|learn|find)/i.test(label),
        })
        continue
      }

      let options: string[] | undefined
      if (input instanceof HTMLSelectElement) {
        options = []
        for (const option of Array.from(input.options)) {
          options.push(option.label || option.value)
        }
      }

      const name = input.getAttribute('name') ?? undefined

      // Radio and checkbox groups are one question, not one question per
      // option. Read individually, a Lever ethnicity question arrives as
      // nineteen fields labelled "White: Irish", "Asian/Asian British:
      // Indian" — none of which look demographic on their own, which is
      // exactly how a demographic question slips past a refusal list.
      if ((type === 'radio' || type === 'checkbox') && name) {
        const existing = found.find((entry) => entry.name === name && entry.type === type)
        if (existing) {
          existing.options = existing.options ?? []
          existing.options.push(label.replace(/\s+/g, ' ').slice(0, 120))
          existing.required ||= input.required || element.getAttribute('aria-required') === 'true'
          continue
        }
        // Prefer the group's own question — a fieldset legend or the
        // application-question wrapper — over the first option's label.
        const group = element.closest('fieldset, .application-question, [role="radiogroup"], .field, [class*="fieldEntry"], [class*="FieldEntry"], [class*="form-field"]')
        const legend = group?.querySelector('legend, .application-label, [role="heading"], label:not([for]), [class*="fieldLabel"], [class*="FieldLabel"]')
        let groupLabel = document.querySelector(`label[for="${CSS.escape(name)}"]`)?.textContent?.trim() ?? legend?.textContent?.trim() ?? ''
        const labelledBy = group?.getAttribute('aria-labelledby')
        if (labelledBy) groupLabel = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim() || groupLabel
        if (!groupLabel || groupLabel === label || legend?.querySelector('input')) {
          // Walk outward past option labels. Opaque UUID names identify fields,
          // not the question a person needs to answer.
          let parent = element.parentElement
          for (let depth = 0; parent && depth < 6; depth++, parent = parent.parentElement) {
            if (Array.from(parent.querySelectorAll<HTMLInputElement>('input:not([type=hidden]),select,textarea')).some(control => control.name && control.name !== name)) break
            const candidates = Array.from(parent.querySelectorAll('legend, label, h1, h2, h3, h4, [role="heading"], [class*="label"], [class*="Label"], p'))
            const question = candidates.find(node => {
              const text = node.textContent?.trim() ?? ''
              return text.length > 5 && text !== label && !node.querySelector('input,select,textarea') && !node.closest('label:has(input)') && !['yes','no','male','female'].includes(text.toLowerCase()) && (text.includes('?') || node.tagName === 'LEGEND' || !node.getAttribute('for'))
            })
            if (question?.textContent) { groupLabel = question.textContent.trim(); break }
          }
        }
        if (!groupLabel) groupLabel = label
        found.push({
          label: groupLabel.replace(/\s+/g, ' ').slice(0, 200),
          type,
          name,
          required: input.required || element.getAttribute('aria-required') === 'true' || group?.getAttribute('aria-required') === 'true' || /(?:[✱*]|\(required\))\s*$/i.test(groupLabel),
          options: [label.replace(/\s+/g, ' ').slice(0, 120)],
        })
        continue
      }

      found.push({
        label: label.replace(/\s+/g, ' ').slice(0, 200),
        type,
        name,
        required: input.required || element.getAttribute('aria-required') === 'true' || /(?:[✱*]|\(required\))\s*$/i.test(label),
        options,
      })
    }

    // Accessible component-library radios may be buttons with no native input.
    for (const group of Array.from(scope.querySelectorAll<HTMLElement>('[role="radiogroup"]'))) {
      const owner = group.closest(entrySel)
      if (owner && processedEntries.includes(owner)) continue
      if (group.querySelector('input[type="radio"]')) continue
      const rect=group.getBoundingClientRect()
      if(!rect.width||!rect.height||getComputedStyle(group).display==='none')continue
      let label=group.getAttribute('aria-label')??''
      const labelledBy=group.getAttribute('aria-labelledby')
      if(labelledBy)label=labelledBy.split(/\s+/).map(id=>document.getElementById(id)?.textContent?.trim()??'').join(' ')
      if(!label)label=group.querySelector('legend,label,[role="heading"]')?.textContent?.trim()??''
      label=label.replace(/start typing\.\.\.?/gi,' ').replace(/\s+/g,' ').trim()
      const options=Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]')).map(option=>option.getAttribute('aria-label')??option.textContent?.trim()??'').filter(Boolean)
      if(label&&options.length)found.push({label:label.trim().slice(0,200),type:'radio',required:group.getAttribute('aria-required')==='true'||/(?:[✱*]|\(required\))\s*$/i.test(label),options})
    }
    for (const widget of Array.from(scope.querySelectorAll<HTMLElement>('.ashby-application-form-input-yesno'))) {
      const entry = widget.closest(entrySel)
      if (entry && processedEntries.includes(entry)) continue
      const rect = widget.getBoundingClientRect()
      if (!rect.width || !rect.height || getComputedStyle(widget).display === 'none') continue
      let label = (entry?.querySelector('label')?.textContent ?? '').replace(/start typing\.\.\.?/gi, ' ').trim()
      if (!label) label = widget.getAttribute('aria-label')?.trim() ?? ''
      const options = Array.from(widget.querySelectorAll('button')).map((button) => (button.textContent ?? '').trim()).filter((text) => /^(yes|no)$/i.test(text))
      if (!label || options.length !== 2) continue
      const required = /(?:[✱*]|\(required\))\s*$/i.test(label) || entry?.querySelector('[aria-required="true"], [required]') !== null
      found.push({ label: label.replace(/\s+/g, ' ').slice(0, 200), type: 'checkbox', required, options: ['Yes', 'No'] })
    }
    for (const editable of Array.from(scope.querySelectorAll<HTMLElement>('[contenteditable="true"]'))) {
      if (covered.includes(editable)) continue
      const style = getComputedStyle(editable)
      if (editable.hidden || style.display === 'none' || style.visibility === 'hidden') continue
      const entry = editable.closest(entrySel)
      let label = (entry?.querySelector('label')?.textContent ?? '').replace(/start typing\.\.\.?/gi, ' ').replace(/\s+/g, ' ').trim()
      if (!label) label = (editable.getAttribute('aria-label') ?? editable.getAttribute('data-placeholder') ?? '').trim()
      if (!label) continue
      const required = /(?:[✱*]|\(required\))\s*$/i.test(label) || editable.getAttribute('aria-required') === 'true'
      found.push({ label: label.replace(/\s+/g, ' ').slice(0, 200), type: 'textarea', required })
    }
    for (const field of found) if (field.type === 'checkbox' && field.options?.length === 1) field.options = []
    return found
  }, { selector: containerSelector ?? null, entrySel: ASHBY_FIELD_ENTRY_SEL })
  return coalesceOptionFields(fields.map((field) => {
    const next = { ...field, label: cleanFieldLabel(correctedFieldLabel(field)) }
    return next.label ? next : field
  }).filter((field) => field.label.trim().length > 0))
}

/**
 * Greenhouse. The most common destination by a wide margin, and the most
 * stable markup — the form is server-rendered and the ids have not moved in
 * years.
 */
const greenhouse: Recipe = {
  id: 'greenhouse',
  matches: (host) => host.includes('greenhouse.io') || host.includes('boards.greenhouse.io'),
  async openForm(page) {
    const cookie = page.getByRole('button', { name: /accept all|accept cookies|i agree|got it/i }).first()
    if (await cookie.isVisible().catch(() => false)) await cookie.click().catch(() => undefined)
    const formReady = '#application_form, form#application-form, #submit_app, input[type="file"][name*="resume" i], input[type="file"][id*="resume" i]'
    if (await page.locator(formReady).count() > 0) {
      await page.waitForSelector('#application_form input, form#application-form input, input[type="file"], select, #submit_app', { timeout: 10_000 }).catch(() => undefined)
      return
    }
    const apply = page.getByRole('link', { name: /apply for this job|apply now|^apply$/i })
      .or(page.getByRole('button', { name: /apply for this job|apply now|^apply$/i }))
      .or(page.locator('a[href*="#gdpr"], a[href*="application"], #apply_button'))
      .first()
    if ((await apply.count()) > 0) {
      await apply.click({ force: true }).catch(() => undefined)
      await page.waitForLoadState('domcontentloaded').catch(() => undefined)
    }
    await page.waitForSelector(formReady, { timeout: 15_000 }).catch(() => undefined)
  },
  fieldContainer: '#application_form, form#application-form, form',
  // Greenhouse's own id first; the generic fallbacks are last on purpose.
  submit: '#submit_app, button:has-text("Submit Application")',
  success: /thank you|application (?:was )?(?:successfully )?submitted|received your application/i,
}

/** Lever. Also server-rendered; the apply form sits behind an "Apply" link. */
const lever: Recipe = {
  id: 'lever',
  matches: (host) => host.includes('lever.co'),
  async openForm(page) {
    const apply = page.getByRole('link', { name: /apply for this job|apply/i }).first()
    if ((await apply.count()) > 0 && (await apply.isVisible())) {
      await apply.click()
      await page.waitForLoadState('domcontentloaded').catch(() => undefined)
    }
  },
  fieldContainer: '.application-form, form[action*="apply"], form',
  // Matched on the button's words, not its type. Lever's real submit is a
  // `button[type="button"]` reading "Submit application", while the page's
  // only `button[type="submit"]` elements belong to the cookie banner — so
  // the old selector would have clicked Accept or Deny and reported a failed
  // submission, having pressed something nobody asked it to press.
  submit: 'button:has-text("Submit Application"), .postings-btn:has-text("Submit")',
  success: /thank you|application (?:was )?(?:successfully )?submitted|we have received/i,
}

/**
 * Ashby. A React application, so the form appears after hydration rather than
 * in the initial HTML — reading fields too early returns an empty list, which
 * looks exactly like a form with no fields.
 */
const ashby: Recipe = {
  id: 'ashby',
  matches: (host) => host.includes('ashbyhq.com'),
  async openForm(page) {
    // "Apply for this Job" is an anchor, not a button, and the form lives on
    // its own route — the job page itself renders zero inputs, so looking for
    // a button here found nothing and the reader saw an empty form.
    const apply = page
      .getByRole('link', { name: /apply for this job|apply/i })
      .or(page.getByRole('button', { name: /apply for this job|apply/i }))
      .first()
    if ((await apply.count()) > 0 && (await apply.isVisible().catch(() => false))) {
      await apply.click().catch(() => undefined)
    } else if (!page.url().includes('/application')) {
      // Ashby also serves the form directly at /application.
      await page.goto(`${page.url().replace(/\/$/, '')}/application`, {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      }).catch(() => undefined)
    }
    // Wait for a real input rather than a fixed delay — this is a React app,
    // so the markup arrives after hydration.
    await page
      .waitForSelector('form input, form textarea, .ashby-application-form-field-entry, [data-field-entry-id], input[type="file"]', { timeout: 15_000 })
      .catch(() => undefined)
  },
  fieldContainer: 'form',
  submit: 'button:has-text("Submit Application")',
  success: /thank you for (?:your )?application|application (?:was )?(?:successfully )?submitted|we (?:have )?received your application/i,
}

/**
 * SmartRecruiters. Listing page has `#st-apply`; the one-click form hydrates
 * after that click. Guest apply (`?oga=true`) is the same widget.
 */
const smartrecruiters: Recipe = {
  id: 'smartrecruiters',
  matches: (host) => host.includes('smartrecruiters.com'),
  async openForm(page) {
    const cookie = page.getByRole('button', { name: /accept all|accept cookies|i agree|got it/i }).first()
    if (await cookie.isVisible().catch(() => false)) await cookie.click().catch(() => undefined)
    const formReady = 'input[name="firstName"], input[name="first_name"], input[name="email"], form input[type="file"], [data-test="first-name"]'
    if (await page.locator(formReady).count() > 0) {
      await page.waitForSelector(formReady, { timeout: 10_000 }).catch(() => undefined)
      return
    }
    const apply = page.locator('#st-apply, a[data-sr-track="apply"], a.js-oneclick')
      .or(page.getByRole('link', { name: /apply for this job|apply now|^apply$/i }))
      .or(page.getByRole('button', { name: /apply for this job|apply now|^apply$/i }))
      .first()
    if ((await apply.count()) > 0) {
      await apply.click({ force: true }).catch(() => undefined)
      await page.waitForLoadState('domcontentloaded').catch(() => undefined)
    }
    await page.waitForURL(/oneclick-ui|oga=true/i, { timeout: 15_000 }).catch(() => undefined)
    await page.waitForSelector(`${formReady}, form input, form textarea, input[type="file"], [data-test="first-name"]`, { timeout: 25_000 }).catch(() => undefined)
    const iframe = page.locator('iframe[src*="oneclick"], iframe[src*="smartrecruiters"], iframe[title*="application" i]').first()
    if (await iframe.count() > 0) {
      const src = await iframe.getAttribute('src')
      if (src && /^https:/i.test(src) && /smartrecruiters|oneclick/i.test(src)) {
        await page.goto(src, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined)
        await page.waitForSelector(formReady, { timeout: 20_000 }).catch(() => undefined)
      }
    }
    const next = page.getByRole('button', { name: /^(next|continue|start application)$/i }).first()
    if (await next.isVisible().catch(() => false)) {
      await next.click().catch(() => undefined)
      await page.waitForSelector(formReady, { timeout: 15_000 }).catch(() => undefined)
    }
  },
  fieldContainer: 'form, [class*="oneclick"], [class*="application"]',
  submit: 'button:has-text("Submit application"), button:has-text("Send application"), button:has-text("Submit"), button:has-text("Send")',
  success: /thank you|application (?:was )?(?:successfully )?submitted|we have received|successfully applied/i,
}

/**
 * Workable. Job page at apply.workable.com/{account}/j/{shortcode}; the form
 * is a widget behind Apply, with a documented `/api/v1/jobs/{id}/form`.
 */
const workable: Recipe = {
  id: 'workable',
  matches: (host) => host.includes('workable.com'),
  async openForm(page) {
    const cookie = page.getByRole('button', { name: /accept all|accept cookies|i agree|got it/i }).first()
    if (await cookie.isVisible().catch(() => false)) await cookie.click().catch(() => undefined)
    const formReady = 'form input[name="firstname"], form input[name="first_name"], input[name="candidate[first_name]"], [data-ui="application-form"] input, form[action*="apply"] input'
    if (await page.locator(formReady).count() > 0) {
      await page.waitForSelector(formReady, { timeout: 10_000 }).catch(() => undefined)
      return
    }
    const apply = page.getByRole('link', { name: /apply for this job|apply now|^apply$/i })
      .or(page.getByRole('button', { name: /apply for this job|apply now|^apply$/i }))
      .first()
    if ((await apply.count()) > 0) {
      await apply.click().catch(() => undefined)
      await page.waitForLoadState('domcontentloaded').catch(() => undefined)
    }
    await page.waitForSelector(`${formReady}, form input, form textarea, input[type="file"]`, { timeout: 15_000 }).catch(() => undefined)
  },
  fieldContainer: 'form, [data-ui="application-form"], .application-form',
  submit: 'button:has-text("Submit application"), button:has-text("Send application"), button:has-text("Submit")',
  success: /thank you|application (?:was )?(?:successfully )?submitted|we have received|successfully applied/i,
}

const RECIPES: Recipe[] = [greenhouse, lever, ashby, smartrecruiters, workable]

export function recipeFor(url: string): Recipe | null {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return RECIPES.find((recipe) => recipe.matches(host)) ?? null
  } catch {
    return null
  }
}

/** Prefer the live host after an aggregator hop onto Greenhouse/Lever/Ashby. */
export function recipeForPage(requestedUrl: string, liveUrl?: string): Recipe | null {
  if (liveUrl) {
    const live = recipeFor(liveUrl)
    if (live) return live
  }
  return recipeFor(requestedUrl)
}

/** Generic fallback for every other portal. */
export const GENERIC: Omit<Recipe, 'id' | 'matches'> = {
  fieldContainer: 'form',
  submit:
    'button[type="submit"], input[type="submit"], button:has-text("Submit application"), button:has-text("Submit")',
  success: /thank you|application (?:was )?(?:successfully )?submitted|successfully applied|we have received/i,
}
