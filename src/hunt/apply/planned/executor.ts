import type { Page } from 'playwright-core'
import { browserFilePayload } from '../../../lib/file-payload.js'
import { logger } from '../../../lib/logger.js'
import { actOnPage, snapshotPage, type PilotElement, type PilotSnapshot } from '../pilot-page.js'
import { matchOption, type PlannedAnswer } from './answers.js'
import { foldLabel } from './schema/fingerprint.js'
import type { SchemaField } from './schema/types.js'

/**
 * Typing answers into the page, and proving each one took.
 *
 * "The fill call returned ok" was the old success criterion. React forms
 * routinely accept a keystroke and then discard it on re-render, and résumé
 * parsers overwrite fields after upload. Every field here is read back from
 * the page after writing, and once more at the end.
 */

export type FieldStatus = 'filled' | 'failed' | 'skipped' | 'not_found' | 'ask'

export interface FieldResult {
  key: string
  label: string
  status: FieldStatus
  committed: string
  attempts: number
  error?: string
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function folded(value: string): string {
  return foldLabel(value).replace(/[^a-z0-9@.+]+/g, ' ').trim()
}

/** Does what the page shows satisfy what we meant to write? */
export function committedSatisfies(answer: PlannedAnswer, committed: string): boolean {
  const have = folded(committed)
  if (!have) return answer.kind === 'checkbox' && answer.values[0] === 'false'
  if (answer.kind === 'checkbox') return answer.values[0] === 'false' ? have !== 'true' : have === 'true' || have === 'yes' || have.length > 0
  if (answer.kind === 'location') return have.length > 1
  if (answer.kind === 'phone') {
    const want = (answer.values[0] ?? '').replace(/\D/g, '')
    const got = committed.replace(/\D/g, '')
    return got.length >= 6 && (want.endsWith(got) || got.endsWith(want.slice(-8)))
  }
  if (answer.kind === 'multiselect') return answer.values.every((value) => have.includes(folded(value)) || folded(value).includes(have))
  const want = folded(answer.values[0] ?? '')
  if (!want) return false
  if (have === want || have.includes(want) || want.includes(have)) return true
  if (answer.kind === 'date') return committed.replace(/\D/g, '').length >= 6
  if (answer.kind === 'textarea' || answer.kind === 'text') return have.slice(0, 40) === want.slice(0, 40)
  return false
}

async function readElement(page: Page, element: PilotElement): Promise<PilotElement | null> {
  const snap = await snapshotPage(page).catch(() => null)
  return snap?.elements.find((row) => row.id === element.id) ?? null
}

/** Labels of the checked boxes inside a checkbox group, read from the DOM. */
async function checkedLabels(page: Page, elementId: string): Promise<string[]> {
  return page.locator(`[data-apply-id="${elementId}"]`).first().evaluate((node) => {
    const out: string[] = []
    for (const input of Array.from(node.querySelectorAll('input[type="checkbox"]'))) {
      if (!(input instanceof HTMLInputElement) || !input.checked) continue
      const id = input.getAttribute('id')
      const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent ?? '' : ''
      out.push((forLabel || input.closest('label')?.textContent || input.value || '').replace(/\s+/g, ' ').trim())
    }
    return out
  }, undefined, { timeout: 3_000 }).catch(() => [] as string[])
}

/** Attach the résumé to this file input (or the page's résumé input) and confirm it is attached. */
export async function attachResumeVerified(page: Page, element: PilotElement | null, resumePath: string): Promise<boolean> {
  const payload = await browserFilePayload(resumePath)
  const scope = element ? page.locator(`[data-apply-id="${element.id}"]`).first() : page.locator('body')
  const own = element?.role === 'file' ? scope : null
  const nested = scope.locator('input[type="file"]')
  const named = page.locator('input[type="file"][name*="resume" i], input[type="file"][id*="resume" i], input[type="file"][name*="cv" i]')
  const candidates = [own, nested.first(), named.first(), page.locator('input[type="file"]').first()].filter(Boolean) as ReturnType<Page['locator']>[]
  for (const input of candidates) {
    if (await input.count().catch(() => 0) === 0) continue
    const isFile = await input.evaluate((node) => node instanceof HTMLInputElement && node.type === 'file', undefined, { timeout: 3_000 }).catch(() => false)
    if (!isFile) continue
    try {
      await input.setInputFiles(payload, { timeout: 10_000 })
    } catch (error) {
      logger.warn({ err: error }, 'résumé upload to a file input failed')
      continue
    }
    // Uploads finish asynchronously: parsers show a spinner, dropzones clear the
    // input and render the file name instead.
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const state = await page.evaluate((name) => {
        const body = document.body?.innerText ?? ''
        const parsing = /parsing your resume|uploading|submitting too early/i.test(body)
        const files = Array.from(document.querySelectorAll('input[type="file"]')).some((node) => node instanceof HTMLInputElement && (node.files?.length ?? 0) > 0)
        return { parsing, files, named: body.includes(name) || body.includes(name.replace(/\.[a-z]+$/i, '')) }
      }, payload.name).catch(() => ({ parsing: false, files: false, named: false }))
      if (!state.parsing && (state.files || state.named)) return true
      await pause(400)
    }
    return false
  }
  return false
}

async function writeOnce(page: Page, element: PilotElement, answer: PlannedAnswer, value: string): Promise<boolean> {
  const result = await actOnPage(page, { op: 'fill', id: element.id, value }).catch((error: unknown) => ({ ok: false, error: String(error) }))
  return Boolean(result.ok)
}

async function writeDate(page: Page, element: PilotElement, value: string): Promise<void> {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
  const host = page.locator(`[data-apply-id="${element.id}"]`).first()
  const input = (await host.evaluate((node) => node instanceof HTMLInputElement, undefined, { timeout: 3_000 }).catch(() => false)) ? host : host.locator('input').first()
  const nativeDate = await input.evaluate((node) => node instanceof HTMLInputElement && node.type === 'date', undefined, { timeout: 3_000 }).catch(() => false)
  if (nativeDate && iso) {
    await input.fill(iso).catch(() => undefined)
    return
  }
  const [y, m, d] = (iso ?? '').split('-')
  for (const candidate of [value, iso && `${m}/${d}/${y}`, iso && `${d}/${m}/${y}`].filter((item): item is string => Boolean(item))) {
    await input.click({ timeout: 3_000 }).catch(() => undefined)
    await input.fill('').catch(() => undefined)
    await input.pressSequentially(candidate, { delay: 30 }).catch(() => undefined)
    await page.keyboard.press('Enter').catch(() => undefined)
    await pause(200)
    const committed = await input.inputValue().catch(() => '')
    if (committed.replace(/\D/g, '').length >= 6) return
  }
}

/**
 * Write one planned answer and verify it. Up to three strategies: the page
 * script, a re-mapped option label read live from the control, then
 * Playwright's own typing.
 */
export async function fillField(page: Page, element: PilotElement, answer: PlannedAnswer, resumePath: string): Promise<FieldResult> {
  const base = { key: answer.key, label: answer.label }
  if (answer.action === 'skip') return { ...base, status: 'skipped', committed: '', attempts: 0 }
  if (answer.action === 'ask') return { ...base, status: 'ask', committed: '', attempts: 0 }
  if (answer.action === 'upload_resume') {
    const ok = await attachResumeVerified(page, element, resumePath)
    return { ...base, status: ok ? 'filled' : 'failed', committed: ok ? 'résumé' : '', attempts: 1, ...(ok ? {} : { error: 'résumé did not attach' }) }
  }
  let attempts = 0
  let lastCommitted = ''
  for (let strategy = 0; strategy < 3; strategy += 1) {
    attempts += 1
    try {
      if (answer.kind === 'multiselect') {
        const already = await checkedLabels(page, element.id)
        for (const value of answer.values) {
          if (already.some((label) => folded(label).includes(folded(value)))) continue
          await writeOnce(page, element, answer, value)
          await pause(150)
        }
        const checked = await checkedLabels(page, element.id)
        const current = await readElement(page, element)
        lastCommitted = checked.length ? checked.join(', ') : current?.value ?? ''
      } else if (answer.kind === 'date') {
        await writeDate(page, element, answer.values[0] ?? '')
        lastCommitted = (await readElement(page, element))?.value ?? ''
      } else {
        let value = answer.values[0] ?? ''
        if (strategy === 1 && ['select', 'boolean'].includes(answer.kind)) {
          // The page's options may be worded differently from the schema's.
          const harvested = await actOnPage(page, { op: 'harvest', id: element.id }).catch(() => null)
          const live = (harvested?.options ?? element.options).map((label) => ({ label }))
          value = matchOption(live, answer.values)?.label ?? value
        }
        if (strategy === 2 && ['text', 'textarea', 'email', 'url', 'number', 'phone'].includes(answer.kind)) {
          const target = page.locator(`[data-apply-id="${element.id}"]`).first()
          const input = (await target.evaluate((node) => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement, undefined, { timeout: 3_000 }).catch(() => false)) ? target : target.locator('input, textarea').first()
          await input.fill(value, { timeout: 5_000 }).catch(() => undefined)
          await input.blur().catch(() => undefined)
        } else {
          await writeOnce(page, element, answer, value)
        }
        await pause(150)
        lastCommitted = (await readElement(page, element))?.value ?? ''
      }
      if (committedSatisfies(answer, lastCommitted)) return { ...base, status: 'filled', committed: lastCommitted, attempts }
    } catch (error) {
      logger.debug({ err: error, label: answer.label }, 'field write attempt failed')
    }
    await page.locator(`[data-apply-id="${element.id}"]`).first().scrollIntoViewIfNeeded().catch(() => undefined)
    await pause(250)
  }
  return { ...base, status: 'failed', committed: lastCommitted, attempts, error: 'value did not stick after three strategies' }
}

/** Fill in page order, so conditional questions reveal themselves in sequence. */
export async function fillAll(params: {
  page: Page
  pairs: Array<{ field: SchemaField; element: PilotElement | null; answer: PlannedAnswer }>
  snapshot: PilotSnapshot
  resumePath: string
  onResult?: (result: FieldResult) => void
}): Promise<FieldResult[]> {
  const order = new Map(params.snapshot.elements.map((element, index) => [element.id, index]))
  const sorted = [...params.pairs].sort((left, right) => (order.get(left.element?.id ?? '') ?? 1e9) - (order.get(right.element?.id ?? '') ?? 1e9))
  const results: FieldResult[] = []
  for (const pair of sorted) {
    const result = pair.element
      ? await fillField(params.page, pair.element, pair.answer, params.resumePath)
      : { key: pair.answer.key, label: pair.answer.label, status: pair.answer.action === 'skip' ? 'skipped' as const : 'not_found' as const, committed: '', attempts: 0 }
    results.push(result)
    params.onResult?.(result)
  }
  return results
}
