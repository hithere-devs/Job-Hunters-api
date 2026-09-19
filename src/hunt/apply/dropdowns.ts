import type { Page } from 'playwright-core'
import { isReferralQuestion, normaliseLabel, sensitiveReason, type FormField } from './fields.js'
import { ASHBY_FIELD_ENTRY_SEL } from './recipes.js'

/**
 * Native <select> and typeahead comboboxes (Ashby/Greenhouse location,
 * "how did you hear") fail when we only set the input text. The provider
 * counts a committed option click, not a typed string.
 */

export interface DropdownPlace {
  city?: string
  region?: string
  country?: string
}

const REFERRAL_ALIASES = [
  'Job board',
  'LinkedIn',
  'Indeed',
  'Company website',
  'Other',
  'Internet',
  'Recruiter',
  'Referral',
  'Glassdoor',
  'Social media',
]

const SOURCE_OPTION = /\b(?:linkedin|indeed|glassdoor|job\s*board|company\s+website|career\s+site|internet|other|recruiter|referral|friend|social|twitter|x\.com|facebook|instagram|google|angellist|wellfound|levels\.fyi)\b/i
const PLACEHOLDER_OPTION = /^(?:select|choose|please\s+select|start typing|type to search|search|loading|no results|nothing found|n\/a|-|–|—)\b/i
const OPTION_SEL = [
  '[role="option"]',
  '.ashby-application-form-input-autocomplete-popup-result',
  '[class*="autocomplete-popup"] [class*="result"]',
  '[class*="Autocomplete"] [class*="option" i]',
  'ul[role="listbox"] li',
  '[id*="downshift-"][role="option"]',
  '[id*="react-select"] [class*="option"]',
  '.select__option',
  '[class*="select__option"]',
  '[data-radix-collection-item]',
].join(', ')

export function isReferralDropdown(field: FormField): boolean {
  return isReferralQuestion(field.label, field.options)
}

export function isLocationDropdown(field: FormField): boolean {
  const label = normaliseLabel(field.label)
  if (/\brelocat|preference|willing\b/i.test(label)) return false
  return /^(?:current\s+)?location(?:\s*\(.*\))?$|^city$|^town$|^country(?:\s*\(.*\))?$|\b(?:current|based\s+in)\s+location$/i.test(label)
}

export function isDropdownField(field: FormField): boolean {
  return /^(combobox|select|select-one|select-multiple)$/i.test(field.type)
}

export function shouldFillDropdown(field: FormField): boolean {
  return isDropdownField(field) || isReferralDropdown(field) || isLocationDropdown(field)
}

function fold(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function isPlaceholderChoice(label: string, value = ''): boolean {
  const text = fold(label || value)
  return !text || PLACEHOLDER_OPTION.test(text)
}

export function scoreOption(query: string, option: string): number {
  const wanted = fold(query)
  const choice = fold(option)
  if (!wanted || !choice || isPlaceholderChoice(choice)) return 0
  if (/^(indian|asian indian|south asian|indian asian)$/.test(wanted) && /american indian|alaska native|native american/.test(choice)) return 0
  if (/^(indian|asian indian|south asian|indian asian|asian)$/.test(wanted) && /east asian|southeast asian|west asian|central asian/.test(choice)) return 0
  if (/^(indian|asian indian|south asian|indian asian)$/.test(wanted) && choice === 'south asian') return 95
  if (/^(indian|asian indian|south asian|indian asian)$/.test(wanted) && (choice === 'asian' || choice.startsWith('asian '))) return 82
  if (/not a (?:protected )?veteran|i am not a/.test(wanted) && /unspecified/.test(choice)) return 0
  if (/not a (?:protected )?veteran|i am not a/.test(wanted) && /vietnam|korean war|armed forces|recently separated/.test(choice)) return 0
  if (/not a (?:protected )?veteran|i am not a/.test(wanted) && /^other /.test(choice)) return 0
  if (/not a (?:protected )?veteran|i am not a/.test(wanted) && /protected veteran/.test(choice) && !/not a|i am not|do not/.test(choice)) return 0
  if (choice === wanted) return 100
  if (choice.startsWith(wanted) || wanted.startsWith(choice)) return 85
  if (choice.includes(wanted) || wanted.includes(choice)) return 70
  const tokens = wanted.split(/[,\s/]+/).filter((token) => token.length > 1)
  if (!tokens.length) return 0
  let hits = 0
  for (const token of tokens) {
    if (choice === token || choice.startsWith(token) || choice.includes(token)) hits += 1
  }
  if (!hits) return 0
  return hits === tokens.length ? 60 : 35 + hits * 8
}

export function pickDropdownChoice(options: string[], queries: string[]): string | null {
  let best: { option: string; score: number } | null = null
  for (const option of options) {
    if (isPlaceholderChoice(option)) continue
    let score = 0
    for (const query of queries) score = Math.max(score, scoreOption(query, option))
    if (!best || score > best.score || (score === best.score && option.length > best.option.length)) best = { option, score }
  }
  return best && best.score >= 35 ? best.option : null
}

/** Sourcing questions are not material. Prefer a known board, else first real option. */
export function pickAnyReferralChoice(options: string[], queries: string[]): string | null {
  return pickDropdownChoice(options, queries)
    ?? options.find((option) => SOURCE_OPTION.test(option) && !isPlaceholderChoice(option))
    ?? options.find((option) => !isPlaceholderChoice(option))
    ?? null
}

export function dropdownQueries(field: FormField, value: string, place?: DropdownPlace): string[] {
  const queries: string[] = []
  const push = (item?: string) => {
    const next = item?.trim()
    if (next && !queries.some((existing) => fold(existing) === fold(next))) queries.push(next)
  }
  push(value)
  if (isLocationDropdown(field)) {
    const city = place?.city?.trim() || value.trim()
    const region = place?.region?.trim()
    const country = place?.country?.trim()
    push(city)
    if (city && country) push(`${city}, ${country}`)
    if (city && region) push(`${city}, ${region}`)
    if (city && region && country) push(`${city}, ${region}, ${country}`)
    push(country)
    if (city.length >= 4) push(city.slice(0, 4))
  }
  if (isReferralDropdown(field)) {
    for (const alias of REFERRAL_ALIASES) push(alias)
  }
  for (const option of field.options ?? []) {
    if (!isPlaceholderChoice(option)) {
      for (const query of [...queries]) {
        if (scoreOption(query, option) >= 70) push(option)
      }
    }
  }
  return queries.filter((item) => !isPlaceholderChoice(item))
}

function escapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function labeledControl(page: Page, field: FormField) {
  const escaped = normaliseLabel(field.label)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .slice(0, 60)
  const byLabel = page.getByLabel(new RegExp(escaped, 'i')).first()
  if (field.name) return byLabel.or(page.locator(`[name="${escapeAttr(field.name)}"]`).first())
  return byLabel
}

async function dropdownControl(page: Page, field: FormField) {
  const escaped = normaliseLabel(field.label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const comboSel = 'input[role="combobox"], input.ashby-application-form-input-autocomplete, input[aria-autocomplete], select'
  const labeled = labeledControl(page, field)
  const combo = labeled
    .or(page.getByRole('combobox', { name: new RegExp(escaped.slice(0, 60), 'i') }).first())
    .or(page.locator(ASHBY_FIELD_ENTRY_SEL).filter({ hasText: new RegExp(escaped.slice(0, 40), 'i') }).locator(comboSel).first())
    .or(page.locator('fieldset').filter({ hasText: new RegExp(escaped.slice(0, 40), 'i') }).locator(comboSel).first())
  if ((await combo.count().catch(() => 0)) > 0) return combo.first()
  return labeled
}

async function optionTexts(page: Page): Promise<string[]> {
  const locator = page.locator(OPTION_SEL)
  const count = Math.min(await locator.count().catch(() => 0), 40)
  const texts: string[] = []
  for (let index = 0; index < count; index += 1) {
    const text = ((await locator.nth(index).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
    if (text && !isPlaceholderChoice(text) && !texts.includes(text)) texts.push(text)
  }
  return texts
}

async function clickOption(page: Page, text: string): Promise<boolean> {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80)
  const option = page.getByRole('option', { name: new RegExp(escaped, 'i') }).first()
    .or(page.locator('.ashby-application-form-input-autocomplete-popup-result').filter({ hasText: new RegExp(escaped, 'i') }).first())
    .or(page.locator(OPTION_SEL).filter({ hasText: new RegExp(escaped, 'i') }).first())
  if ((await option.count().catch(() => 0)) === 0) return false
  await option.scrollIntoViewIfNeeded().catch(() => undefined)
  await option.click({ timeout: 4_000 }).catch(() => undefined)
  return true
}

async function committedValue(page: Page, field: FormField): Promise<string> {
  const control = await dropdownControl(page, field)
  const invalid = await control.getAttribute('aria-invalid').catch(() => null)
  if (invalid === 'true') return ''
  if (await control.evaluate((element) => element instanceof HTMLSelectElement).catch(() => false)) {
    return control.evaluate((element) => {
      if (!(element instanceof HTMLSelectElement)) return ''
      const option = element.selectedOptions[0]
      return (option?.label || element.value || '').trim()
    }).catch(() => '')
  }
  const value = (await control.inputValue().catch(() => '')).trim()
  if (!value) {
    const text = ((await control.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
    return isPlaceholderChoice(text) ? '' : text
  }
  return isPlaceholderChoice(value) ? '' : value
}

async function isCommitted(page: Page, field: FormField): Promise<boolean> {
  const value = await committedValue(page, field)
  return value.length > 0 && !/^start typing/i.test(value)
}

async function typeQuery(control: ReturnType<Page['locator']>, query: string): Promise<void> {
  await control.click({ timeout: 5_000 }).catch(() => undefined)
  await control.fill('').catch(() => undefined)
  try {
    await control.pressSequentially(query, { delay: 35, timeout: 8_000 })
  } catch {
    await control.fill(query).catch(() => undefined)
  }
}

async function openTypeahead(control: ReturnType<Page['locator']>): Promise<void> {
  await control.evaluate((element) => {
    const parent = element.parentElement
    const toggle = parent?.querySelector('button')
    if (toggle instanceof HTMLElement) toggle.click()
  }).catch(() => undefined)
}

async function commitNativeSelect(page: Page, field: FormField, queries: string[], locked: boolean): Promise<boolean> {
  const control = await dropdownControl(page, field)
  const tag = await control.evaluate((element) => element instanceof HTMLSelectElement).catch(() => false)
  if (!tag) return false
  const options = await control.evaluate((element) => {
    if (!(element instanceof HTMLSelectElement)) return []
    return Array.from(element.options).map((option) => ({ label: option.label || option.textContent || '', value: option.value }))
  }).catch(() => [] as Array<{ label: string; value: string }>)
  const labels = options.map((option) => option.label || option.value)
  let choice = pickDropdownChoice(labels, queries)
  if (!choice && !locked && isReferralDropdown(field)) choice = pickAnyReferralChoice(labels, queries)
  if (!choice) return false
  const row = options.find((option) => option.label === choice || option.value === choice)
  try {
    await control.selectOption({ label: choice })
  } catch {
    if (row?.value) await control.selectOption({ value: row.value })
    else return false
  }
  return isCommitted(page, field)
}

async function commitTypeahead(page: Page, field: FormField, queries: string[], locked: boolean): Promise<boolean> {
  const control = await dropdownControl(page, field)
  if ((await control.count().catch(() => 0)) === 0) return false
  await control.scrollIntoViewIfNeeded().catch(() => undefined)
  if (!locked && isReferralDropdown(field)) {
    await control.click({ timeout: 5_000 }).catch(() => undefined)
    await openTypeahead(control)
    await page.waitForSelector(OPTION_SEL, { state: 'visible', timeout: 2_500 }).catch(() => undefined)
    let listed = await optionTexts(page)
    if (!listed.length) {
      await typeQuery(control, 'a')
      await page.waitForSelector(OPTION_SEL, { state: 'visible', timeout: 2_500 }).catch(() => undefined)
      listed = await optionTexts(page)
    }
    const listedChoice = pickAnyReferralChoice(listed, queries)
    if (listedChoice && await clickOption(page, listedChoice) && await isCommitted(page, field)) return true
  }
  const attempts = queries.slice(0, 5)
  for (const query of attempts) {
    await typeQuery(control, query)
    await page.waitForSelector(OPTION_SEL, { state: 'visible', timeout: 2_500 }).catch(() => undefined)
    let options = await optionTexts(page)
    if (!options.length) {
      await openTypeahead(control)
      await page.waitForSelector(OPTION_SEL, { state: 'visible', timeout: 2_500 }).catch(() => undefined)
      options = await optionTexts(page)
    }
    let choice = pickDropdownChoice(options, [query, ...queries])
    if (!choice && !locked && isReferralDropdown(field)) choice = pickAnyReferralChoice(options, [query, ...queries])
    if (!choice && !locked && isLocationDropdown(field) && options.length === 1) choice = options[0] ?? null
    if (choice && await clickOption(page, choice) && await isCommitted(page, field)) return true
    if (options.length) {
      await page.keyboard.press('ArrowDown').catch(() => undefined)
      await page.keyboard.press('Enter').catch(() => undefined)
      if (await isCommitted(page, field)) return true
    }
  }
  await page.keyboard.press('Enter').catch(() => undefined)
  return isCommitted(page, field)
}

async function commitButtonMenu(page: Page, field: FormField, queries: string[], locked: boolean): Promise<boolean> {
  const name = new RegExp(normaliseLabel(field.label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 60), 'i')
  const button = page.getByRole('combobox', { name }).first()
    .or(page.getByRole('button', { name }).first())
  if ((await button.count().catch(() => 0)) === 0) return false
  const tag = await button.evaluate((element) => element instanceof HTMLSelectElement || (element instanceof HTMLInputElement && element.type !== 'button')).catch(() => false)
  if (tag) return false
  await button.scrollIntoViewIfNeeded().catch(() => undefined)
  await button.click({ timeout: 5_000 }).catch(() => undefined)
  await page.waitForSelector(OPTION_SEL, { state: 'visible', timeout: 2_500 }).catch(() => undefined)
  const options = (await optionTexts(page)).concat(field.options ?? [])
  let choice = pickDropdownChoice(options, queries)
  if (!choice && !locked && isReferralDropdown(field)) choice = pickAnyReferralChoice(options, queries)
  if (!choice) return false
  if (await clickOption(page, choice) && await isCommitted(page, field)) return true
  const byText = page.getByRole('option', { name: choice }).first().or(page.getByText(choice, { exact: true }).first())
  await byText.click({ timeout: 4_000 }).catch(() => undefined)
  return isCommitted(page, field)
}

export async function fillDropdown(page: Page, field: FormField, value: string, place?: DropdownPlace): Promise<boolean> {
  if (!value.trim() || isPlaceholderChoice(value)) return false
  const locked = Boolean(sensitiveReason(field.label, field.options))
  const queries = dropdownQueries(field, value, place)
  if (!queries.length) return false
  if (await commitNativeSelect(page, field, queries, locked)) return true
  if (await commitTypeahead(page, field, queries, locked)) return true
  if (await commitButtonMenu(page, field, queries, locked)) return true
  return false
}
