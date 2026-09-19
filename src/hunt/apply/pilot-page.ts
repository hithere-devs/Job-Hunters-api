import type { Page } from 'playwright-core'
import { applyExtensionPageScript } from './extension-path.js'
import type { FormField } from './fields.js'

export interface PilotElement {
  id: string
  role: string
  label: string
  required: boolean
  value: string
  filled: boolean
  options: string[]
  enabled: boolean
  name?: string
}

export interface PilotSnapshot {
  url: string
  title: string
  text: string
  looksLikeForm: boolean
  elements: PilotElement[]
}

export interface PilotActCommand {
  op: 'fill' | 'click' | 'select' | 'check' | 'clear' | 'harvest' | 'upload'
  id: string
  value?: string
}

export interface PilotActResult {
  ok: boolean
  id?: string
  committed?: string
  filled?: boolean
  options?: string[]
  error?: string
  role?: string
}

const API = '__APPLY_PILOT__'

const PILOT_VERSION = 16
/** After typing in a dropdown, wait so the typeahead can finish before Jev or a click. */
export const DROPDOWN_AFTER_TYPE_MS = 2_000

export async function ensureApplyPilot(page: Page, options?: { injectIfMissing?: boolean }): Promise<void> {
  const injectIfMissing = options?.injectIfMissing !== false
  const httpPage = page.url().startsWith('http://') || page.url().startsWith('https://')
  const budget = !injectIfMissing ? 8_000 : httpPage ? 2_000 : 0
  const deadline = Date.now() + budget
  while (true) {
    const version = await page.evaluate((key) => {
      const api = (window as unknown as Record<string, { version?: number } | undefined>)[key]
      return api?.version ?? 0
    }, API).catch(() => 0)
    if (version >= PILOT_VERSION) return
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!injectIfMissing) throw new Error('Apply Pilot extension did not inject on this page')
  await page.addScriptTag({ path: applyExtensionPageScript() })
  await page.waitForFunction(({ key, version }) => {
    const api = (window as unknown as Record<string, { version?: number } | undefined>)[key]
    return (api?.version ?? 0) >= version
  }, { key: API, version: PILOT_VERSION }, { timeout: 10_000 })
}

export async function snapshotPage(page: Page): Promise<PilotSnapshot> {
  await ensureApplyPilot(page)
  return page.evaluate((key) => {
    const api = (window as unknown as Record<string, { snapshot: () => PilotSnapshot } | undefined>)[key]
    if (!api) throw new Error('Apply Pilot is not on this page')
    return api.snapshot()
  }, API)
}

function foldChoice(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function optionAliases(value: string): string[] {
  const wanted = foldChoice(value)
  if (wanted === 'male' || wanted === 'man') return ['male', 'man']
  if (wanted === 'female' || wanted === 'woman') return ['female', 'woman']
  if (wanted === 'true' || wanted === 'yes') return ['i agree', 'yes', 'true']
  if (wanted === 'indian' || wanted === 'asian indian' || wanted === 'south asian' || wanted === 'indian asian') {
    return ['asian indian', 'south asian', 'indian (asian)', 'asian']
  }
  if (/not a (?:protected )?veteran|i am not a protected veteran|no military service/.test(wanted)) {
    return ['no military service', 'i am not a protected veteran', 'i am not a veteran', 'not a veteran']
  }
  if (/bangalore|bengaluru/.test(wanted)) return ['bangalore', 'bengaluru']
  return wanted ? [wanted] : []
}

function optionMatches(label: string, value: string): boolean {
  const have = foldChoice(label)
  const needles = optionAliases(value)
  if (!have || !needles.length) return false
  if (/american indian|alaska native|native american/.test(have) && needles.some((needle) => needle.includes('indian') || needle === 'asian')) return false
  if (/east asian|southeast asian|west asian|central asian/.test(have) && needles.some((needle) => /indian|south asian|asian/.test(needle))) return false
  if (/unspecified/.test(have) && needles.some((needle) => /not a|i am not/.test(needle))) return false
  if (/^other /.test(have) && needles.some((needle) => /not a|i am not/.test(needle))) return false
  if (/protected veteran/.test(have) && !/not a|i am not|do not/.test(have) && needles.some((needle) => /not a|i am not/.test(needle))) return false
  return needles.some((needle) => (
    have === needle
    || have.startsWith(`${needle} `)
    || have.startsWith(`${needle},`)
    || needle.startsWith(have)
    || (needle.length >= 4 && have.includes(needle))
  ))
}

async function readCommitted(page: Page, id: string): Promise<{ filled: boolean; committed: string }> {
  return page.evaluate(({ key, id: target }) => {
    const api = (window as unknown as Record<string, { snapshot: () => PilotSnapshot } | undefined>)[key]
    const row = api?.snapshot().elements.find((element) => element.id === target)
    return { filled: Boolean(row?.filled), committed: row?.value || '' }
  }, { key: API, id }).catch(() => ({ filled: false, committed: '' }))
}

async function commitSelectWithPlaywright(page: Page, id: string, value: string): Promise<PilotActResult | null> {
  const host = page.locator(`[data-apply-id="${id}"]`).first()
  if (await host.count().catch(() => 0) === 0) return null
  const shell = host.locator('xpath=ancestor-or-self::*[contains(@class,"field-wrapper") or contains(@class,"select-shell") or contains(@class,"select__control")][1]').first()
  const root = (await shell.count().catch(() => 0)) > 0 ? shell : host
  const toggle = root.locator('button[aria-label="Toggle flyout"]').first()
  const control = root.locator('.select__control').first()
  const input = root.locator('input[role="combobox"], [role="combobox"]').first()
  const menuOption = page.locator('.select__menu .select__option, .select__menu [role="option"]')
  const menuVisible = async () => menuOption.first().isVisible().catch(() => false)
  const clickMatchingOption = async (): Promise<boolean> => {
    const exact = menuOption.filter({ hasText: new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }).first()
    if (await exact.isVisible().catch(() => false)) {
      await exact.click({ timeout: 4_000, force: true }).catch(() => undefined)
      return true
    }
    const count = await menuOption.count().catch(() => 0)
    for (let index = 0; index < count; index += 1) {
      const option = menuOption.nth(index)
      if (!await option.isVisible().catch(() => false)) continue
      const label = await option.innerText().catch(() => '')
      if (!optionMatches(label, value) && foldChoice(label) !== foldChoice(value)) continue
      await option.click({ timeout: 4_000, force: true }).catch(() => undefined)
      return true
    }
    return false
  }
  await host.scrollIntoViewIfNeeded().catch(() => undefined)
  if (!await menuVisible()) {
    if (await toggle.count().catch(() => 0) > 0) await toggle.click({ timeout: 5_000 }).catch(() => undefined)
    else if (await control.count().catch(() => 0) > 0) await control.click({ timeout: 5_000 }).catch(() => undefined)
    else await host.click({ timeout: 5_000 }).catch(() => undefined)
    await menuOption.first().waitFor({ state: 'visible', timeout: 2_500 }).catch(() => undefined)
  }
  const query = value.split(',')[0]!.trim()
  const typed = (await input.count().catch(() => 0)) > 0 ? input : host
  const looksLikePlace = /,/.test(value) || /bangalore|bengaluru|city/i.test(value)
  if (!looksLikePlace && await clickMatchingOption()) {
    /* already committed from an open menu */
  } else {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await readCommitted(page, id).then((row) => row.filled).catch(() => false)) break
      await typed.click({ timeout: 3_000 }).catch(() => undefined)
      await typed.fill('').catch(() => undefined)
      await typed.pressSequentially(query, { delay: 50 }).catch(async () => {
        await page.keyboard.type(query, { delay: 50 }).catch(() => undefined)
      })
      await new Promise((resolve) => setTimeout(resolve, DROPDOWN_AFTER_TYPE_MS))
      const typedOption = page.getByRole('option').filter({ hasText: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first()
      await typedOption.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined)
      if (await typedOption.isVisible().catch(() => false)) {
        await typedOption.click({ timeout: 4_000 }).catch(() => undefined)
      } else {
        await clickMatchingOption()
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 220))
  const check = await readCommitted(page, id)
  if (check.filled) return { ok: true, id, committed: check.committed, filled: true }
  return null
}

export async function typeAndListDropdownOptions(page: Page, id: string, query: string): Promise<string[]> {
  await ensureApplyPilot(page)
  const host = page.locator(`[data-apply-id="${id}"]`).first()
  if (await host.count().catch(() => 0) === 0) return []
  const input = host.locator('input[role="combobox"], [role="combobox"]').first()
  const typed = (await input.count().catch(() => 0)) > 0 ? input : host
  const needle = query.split(',')[0]!.trim()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await typed.click({ timeout: 4_000 }).catch(() => undefined)
    await typed.fill('').catch(() => undefined)
    await typed.pressSequentially(needle, { delay: 50 }).catch(async () => {
      await page.keyboard.type(needle, { delay: 50 }).catch(() => undefined)
    })
    await new Promise((resolve) => setTimeout(resolve, DROPDOWN_AFTER_TYPE_MS))
    await page.getByRole('option').first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined)
    const texts = await page.getByRole('option').allTextContents().catch(() => [])
    const listed = [...new Set(texts.map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean))]
    if (listed.length) return listed
  }
  return []
}

export async function clickListedDropdownOption(page: Page, text: string): Promise<boolean> {
  const exact = page.getByRole('option', { name: text, exact: true }).first()
  if (await exact.isVisible().catch(() => false)) {
    await exact.click({ timeout: 4_000 }).catch(() => undefined)
    return true
  }
  const fuzzy = page.getByRole('option').filter({ hasText: text.split(',')[0]!.trim() }).first()
  if (await fuzzy.isVisible().catch(() => false)) {
    await fuzzy.click({ timeout: 4_000 }).catch(() => undefined)
    return true
  }
  return false
}

export async function clickRadioOption(page: Page, question: string, value: string): Promise<boolean> {
  const wanted = String(value).split(/[,(]/)[0]!.trim()
  if (!wanted) return false
  const needle = question.replace(/\s+/g, ' ').trim().slice(0, 80)
  const group = page.locator('li.application-question, fieldset, [role="radiogroup"]').filter({ hasText: needle }).first()
  const scope = (await group.count().catch(() => 0)) > 0 ? group : page
  const named = scope.getByRole('radio', { name: new RegExp(`^\\s*${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }).first()
  if (await named.count().catch(() => 0) > 0) {
    await named.click({ timeout: 3_000, force: true }).catch(() => undefined)
    if (await named.isChecked().catch(() => false)) return true
  }
  const byLabel = scope.getByLabel(new RegExp(`^\\s*${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i')).first()
  await byLabel.click({ timeout: 3_000, force: true }).catch(() => undefined)
  return byLabel.isChecked().catch(() => false)
}

export async function actOnPage(page: Page, command: PilotActCommand): Promise<PilotActResult> {
  await ensureApplyPilot(page)
  const work = page.evaluate(async ({ key, command: next }) => {
    const api = (window as unknown as Record<string, { act: (cmd: PilotActCommand) => Promise<PilotActResult> } | undefined>)[key]
    if (!api) throw new Error('Apply Pilot is not on this page')
    return api.act(next)
  }, { key: API, command })
  const timeout = new Promise<PilotActResult>((resolve) => {
    setTimeout(() => resolve({ ok: false, error: 'timeout', id: command.id }), 15_000)
  })
  const result = await Promise.race([work, timeout])
  if ((command.op === 'fill' || command.op === 'select' || command.op === 'check') && command.value && (!result.ok || result.filled === false)) {
    const snap = await snapshotPage(page).catch(() => null)
    const row = snap?.elements.find((element) => element.id === command.id)
    if (row && (row.role === 'radio' || row.role === 'yesno')) {
      const clicked = await clickRadioOption(page, row.label, command.value)
      if (clicked) return { ok: true, id: command.id, filled: true, committed: command.value }
    }
    const repaired = await commitSelectWithPlaywright(page, command.id, command.value)
    if (repaired) return repaired
  }
  return result
}

export function elementToField(element: PilotElement): FormField {
  const role = element.role
  const type = role === 'textbox' ? 'text'
    : role === 'yesno' ? 'checkbox'
      : role === 'combobox' ? 'combobox'
        : role
  return {
    fid: element.id,
    label: element.label,
    type,
    required: element.required,
    ...(element.name ? { name: element.name } : {}),
    ...(element.options.length ? { options: element.options } : {}),
  }
}

export async function inventoryFields(page: Page, _selector?: string): Promise<FormField[]> {
  const snap = await snapshotPage(page)
  return snap.elements
    .filter((element) => element.role !== 'button' && element.role !== 'link')
    .map(elementToField)
}

function foldLabel(value: string): string {
  return value.replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function matchElement(snap: PilotSnapshot, field: FormField): PilotElement | undefined {
  if (field.fid) {
    const byId = snap.elements.find((element) => element.id === field.fid)
    if (byId) return byId
  }
  const wanted = foldLabel(field.label)
  return snap.elements.find((element) => {
    const have = foldLabel(element.label)
    return have === wanted || have.includes(wanted) || wanted.includes(have)
  })
}

export async function fillPageField(page: Page, field: FormField, value: string, _place?: unknown): Promise<boolean> {
  const snap = await snapshotPage(page)
  const match = matchElement(snap, field)
  if (!match) return false
  const result = await actOnPage(page, { op: 'fill', id: match.id, value })
  return result.ok === true && result.filled !== false
}

export async function fillPageFieldDetailed(
  page: Page,
  field: FormField,
  value: string,
  _place?: unknown,
): Promise<{ filled: boolean; committed: string | null }> {
  const snap = await snapshotPage(page)
  const match = matchElement(snap, field)
  if (!match) return { filled: false, committed: null }
  const result = await actOnPage(page, { op: 'fill', id: match.id, value })
  return { filled: result.ok === true && result.filled !== false, committed: result.committed ?? null }
}

export async function emptyRequiredFields(page: Page): Promise<FormField[]> {
  const snap = await snapshotPage(page)
  return snap.elements
    .filter((element) => element.required && !element.filled && !['button', 'link', 'file'].includes(element.role))
    .map(elementToField)
}

export async function pageLooksLikeHuntlyForm(page: Page): Promise<boolean> {
  await ensureApplyPilot(page).catch(() => undefined)
  const snap = await snapshotPage(page).catch(() => null)
  return Boolean(snap?.looksLikeForm)
}

export async function harvestFieldOptions(page: Page, field: FormField): Promise<string[]> {
  if (!field.fid) return field.options ?? []
  const result = await actOnPage(page, { op: 'harvest', id: field.fid })
  return result.options ?? []
}

/** Back-compat name used by the old driver and tests. */
export const ensureHuntlyApply = ensureApplyPilot
