import {providerSubmissionBlocked, providerValidationFailed} from './provider-block.js'
import { pageHasVerificationGate } from './pilot-outcome.js'
import { verificationInputsFilled } from './gmail-code.js'
import { beforeSubmission } from './submission-guard.js'
import { browserFilePayload } from '../../lib/file-payload.js'
import type { Page } from 'playwright-core'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import type { PortalProfile } from '../portal-profile.js'
import { publishAttemptEvent } from './events.js'
import { isReferralQuestion, normaliseLabel, resolveField, type FormField, type Rung } from './fields.js'
import type { AuthorisationContext } from './work-authorisation.js'
import { greenhouseJobMissing } from './greenhouse-schema.js'
import { ASHBY_FIELD_ENTRY_SEL, GENERIC, greenhouseJobPathUrl, greenhousePostingGoneUrl, readFields, recipeFor, recipeForPage, type Recipe } from './recipes.js'
import { fillDropdown, shouldFillDropdown, type DropdownPlace } from './dropdowns.js'
import type { BlockedReason } from './state.js'

/**
 * Filling one application form.
 *
 * Separated from the surrounding bookkeeping so it can be reasoned about — and
 * tested — on its own: given a page and a profile, what got filled, what did
 * not, and is there anything a human has to deal with.
 */

export interface FilledField {
  label: string
  via: Rung
  filled: boolean
  /** What we actually typed or selected. Empty if we could not fill it. */
  value?: string
  /** kit = My Kit, jev = TypeSafe choice, llm = written draft, page = read back from the form. */
  source?: 'kit' | 'jev' | 'llm' | 'page' | 'agent'
}

export interface FillResult {
  fields: FilledField[]
  /** Required fields nobody could answer. Non-empty means blocked. */
  unresolved: Array<{ label: string; type: string; name?: string; required?: boolean; options?:string[]; why: BlockedReason }>
  recipe: string
}

/**
 * Escapes a value for use inside an attribute selector.
 *
 * `CSS.escape` lives here in Node, not the browser, so calling it threw
 * "CSS is not defined" and broke every Lever application outright — the
 * platform whose forms name their controls rather than labelling them.
 * Only the quote and the backslash can break out of `[name="..."]`.
 */
function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Locates a control by its label, the way the reader paired them. */
function controlFor(page: Page, field: FormField) {
  // Match on the normalised label, not the raw one. The DOM label carries the
  // required marker ("First Name*") because it comes from a sibling span, but
  // the *accessible* name usually does not — so a regex built from the raw
  // text matched nothing and the candidate's own name went unfilled.
  const escaped = normaliseLabel(field.label)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .slice(0, 60)
  const byLabel = page.getByLabel(new RegExp(escaped, 'i')).first()
  if (field.name) {
    return byLabel.or(page.locator(`[name="${escapeAttributeValue(field.name)}"]`).first())
  }
  return byLabel
}

function yesNoWanted(value: string): 'Yes' | 'No' | null {
  const trimmed = value.trim()
  if (/^(?:true|yes)\b/i.test(trimmed) || /^y$/i.test(trimmed)) return 'Yes'
  if (/^(?:false|no)\b/i.test(trimmed) || /^n$/i.test(trimmed)) return 'No'
  return null
}

async function setAshbyYesNo(page: Page, field: FormField, value: string): Promise<boolean> {
  const wanted = yesNoWanted(value) ?? (field.options?.includes(value) ? value : null)
  if (!wanted) return false
  return page.evaluate(({ label, wanted, entrySel }) => {
    let wantedLabel = label.trim()
    wantedLabel = wantedLabel.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/\*$/, '').trim().toLowerCase()
    let wantedChoice = wanted.trim()
    wantedChoice = wantedChoice.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/\*$/, '').trim().toLowerCase()
    const entries = Array.from(document.querySelectorAll(entrySel)).filter((entry) => {
      const labels = Array.from(entry.querySelectorAll('label')).map((node) => {
        let text = (node.textContent ?? '').trim()
        text = text.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/\*$/, '').trim().toLowerCase()
        return text
      })
      return labels.some((text) => text === wantedLabel || text.includes(wantedLabel) || wantedLabel.includes(text))
    })
    const entry = entries.find((node) => node.querySelector('.ashby-application-form-input-yesno')) ?? entries[0]
    if (!entry) return false
    const buttons = Array.from(entry.querySelectorAll('.ashby-application-form-input-yesno > button'))
    const target = buttons.find((button) => {
      let text = (button.textContent ?? '').trim()
      text = text.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/\*$/, '').trim().toLowerCase()
      return text === wantedChoice || (wantedChoice === 'yes' && text === 'yes') || (wantedChoice === 'no' && text === 'no')
    })
    if (!(target instanceof HTMLElement)) return false
    target.click()
    const pressed = buttons.find((button) => button.getAttribute('aria-pressed') === 'true')
    if (!pressed) return true
    return pressed === target
  }, { label: field.label, wanted, entrySel: ASHBY_FIELD_ENTRY_SEL }).catch(() => false)
}

async function setValueInAshbyEntry(page: Page, field: FormField, value: string): Promise<boolean> {
  return page.evaluate(({ label, value, type, entrySel }) => {
    let wantedLabel = label.trim()
    wantedLabel = wantedLabel.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').trim().toLowerCase()
    let wantedValue = value.trim()
    wantedValue = wantedValue.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').trim().toLowerCase()
    const entries = Array.from(document.querySelectorAll(entrySel))
    let entry = entries.find((node) => {
      const labels = Array.from(node.querySelectorAll('label')).map((item) => {
        let text = (item.textContent ?? '').trim()
        text = text.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').trim().toLowerCase()
        return text
      })
      let body = (node.textContent ?? '').trim()
      body = body.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').trim().toLowerCase()
      return labels.some((text) => text === wantedLabel || text.includes(wantedLabel) || wantedLabel.includes(text)) || body.includes(wantedLabel)
    })
    if (!entry && (type === 'radio' || type === 'checkbox')) {
      entry = entries.find((node) => {
        let body = (node.textContent ?? '').trim()
        body = body.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').trim().toLowerCase()
        return body.includes(wantedValue)
      })
    }
    const optionNode = Array.from(document.querySelectorAll('label, button, [role="radio"]')).find((node) => {
      let text = (node.textContent ?? '').trim()
      text = text.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').trim().toLowerCase()
      return text === wantedValue || (wantedValue.length > 8 && text.startsWith(wantedValue))
    })
    if (!entry && optionNode) {
      if (optionNode instanceof HTMLElement) optionNode.click()
      return true
    }
    if (!entry) return false
    const yesno = entry.querySelector('.ashby-application-form-input-yesno')
    if (yesno) {
      const wantedYesNo = /^(true|yes)\b/i.test(value.trim()) ? 'yes' : /^(false|no)\b/i.test(value.trim()) ? 'no' : wantedValue
      const buttons = Array.from(yesno.querySelectorAll('button'))
      const target = buttons.find((button) => {
        let text = (button.textContent ?? '').trim()
        text = text.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').trim().toLowerCase()
        return text === wantedYesNo
      })
      if (!target) return false
      target.click()
      return true
    }
    const combo = entry.querySelector('input[role="combobox"], input.ashby-application-form-input-autocomplete')
    if (combo instanceof HTMLInputElement && (type === 'combobox' || type === 'text')) {
      combo.focus()
      combo.value = value
      combo.dispatchEvent(new Event('input', { bubbles: true }))
      combo.dispatchEvent(new Event('change', { bubbles: true }))
      return combo.value.trim().length > 0 && !/^start typing/i.test(combo.value)
    }
    const select = entry.querySelector('select')
    if (select instanceof HTMLSelectElement) {
      const option = Array.from(select.options).find((item) => {
        let text = item.label.trim()
        text = text.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').trim().toLowerCase()
        return text === wantedValue || item.value === value
      })
      if (!option) return false
      select.value = option.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    const radios = Array.from(entry.querySelectorAll('input[type="radio"]'))
    if (radios.length) {
      const match = radios.find((radio) => {
        if (!(radio instanceof HTMLInputElement)) return false
        const id = radio.id
        const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent ?? '' : ''
        const wrap = radio.closest('label')?.textContent ?? ''
        const sibling = radio.parentElement?.querySelector('label')?.textContent ?? ''
        let forKey = forLabel.trim().replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').trim().toLowerCase()
        let wrapKey = wrap.trim().replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').trim().toLowerCase()
        let siblingKey = sibling.trim().replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').trim().toLowerCase()
        return forKey === wantedValue || wrapKey === wantedValue || siblingKey === wantedValue || radio.value === value || forKey.startsWith(wantedValue) || siblingKey.startsWith(wantedValue)
      })
      const target = match instanceof HTMLInputElement ? match : (radios.length === 1 && radios[0] instanceof HTMLInputElement ? radios[0] : undefined)
      if (!target) return false
      target.click()
      return target.checked
    }
    const textarea = entry.querySelector('textarea')
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.focus()
      textarea.value = value
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
      return textarea.value.trim().length > 0
    }
    const editable = entry.querySelector('[contenteditable="true"]')
    if (editable instanceof HTMLElement) {
      editable.focus()
      editable.innerText = value
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }))
      return (editable.innerText ?? '').trim().length > 0
    }
    const input = entry.querySelector('input:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"]):not([type="password"])')
    if (input instanceof HTMLInputElement) {
      input.focus()
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return input.value.trim().length > 0
    }
    if (optionNode instanceof HTMLElement) {
      optionNode.click()
      return true
    }
    const choice = Array.from(entry.querySelectorAll('button, [role="radio"], label')).find((node) => {
      let text = (node.textContent ?? '').trim()
      text = text.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').trim().toLowerCase()
      return text === wantedValue || text.startsWith(wantedValue)
    })
    if (choice instanceof HTMLElement) {
      choice.click()
      return true
    }
    return false
  }, { label: field.label, value, type: field.type, entrySel: ASHBY_FIELD_ENTRY_SEL }).catch(() => false)
}

export async function fieldLooksEmpty(page: Page, field: FormField): Promise<boolean> {
  return page.evaluate(({ label, type, name, options, entrySel }) => {
    let wanted = label.trim()
    wanted = wanted.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').replace(/\*$/, '').trim().toLowerCase()
    const wantedOptions: string[] = []
    for (const option of options ?? []) {
      let key = option.trim()
      key = key.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').replace(/\*$/, '').trim().toLowerCase()
      if (key) wantedOptions.push(key)
    }
    const entries = Array.from(document.querySelectorAll(entrySel))
    const optionEntries = []
    if (wantedOptions.length) {
      for (const node of entries) {
        let body = (node.textContent ?? '').trim()
        body = body.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').replace(/\*$/, '').trim().toLowerCase()
        let hit = false
        for (const option of wantedOptions) if (body.includes(option) || option.includes(body)) hit = true
        if (hit) optionEntries.push(node)
      }
    }
    if (optionEntries.length) {
      const radios: HTMLInputElement[] = []
      const checks: HTMLInputElement[] = []
      for (const node of optionEntries) {
        for (const radio of Array.from(node.querySelectorAll('input[type="radio"]'))) if (radio instanceof HTMLInputElement) radios.push(radio)
        for (const box of Array.from(node.querySelectorAll('input[type="checkbox"]'))) if (box instanceof HTMLInputElement) checks.push(box)
      }
      if (radios.length) {
        let empty = true
        for (const radio of radios) if (radio.checked) empty = false
        return empty
      }
      if (checks.length) {
        let empty = true
        for (const box of checks) if (box.checked) empty = false
        return empty
      }
    }
    if (wantedOptions.length) {
      const optionLabels: HTMLLabelElement[] = []
      for (const node of Array.from(document.querySelectorAll('label'))) {
        if (!(node instanceof HTMLLabelElement)) continue
        let text = (node.textContent ?? '').trim()
        text = text.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').replace(/\*$/, '').trim().toLowerCase()
        if (wantedOptions.includes(text)) optionLabels.push(node)
      }
      if (optionLabels.length) {
        let empty = true
        for (const node of optionLabels) {
          const control = node.htmlFor ? document.getElementById(node.htmlFor) : node.querySelector('input')
          if (control instanceof HTMLInputElement && control.checked) empty = false
        }
        return empty
      }
    }
    let entry: Element | undefined
    for (const node of entries) {
      const labels: string[] = []
      for (const item of Array.from(node.querySelectorAll('label'))) {
        let text = (item.textContent ?? '').trim()
        text = text.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').replace(/\*$/, '').trim().toLowerCase()
        labels.push(text)
      }
      let body = (node.textContent ?? '').trim()
      body = body.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').replace(/\*$/, '').trim().toLowerCase()
      let hit = body.includes(wanted)
      for (const text of labels) if (text === wanted || text.includes(wanted) || wanted.includes(text)) hit = true
      if (hit) { entry = node; break }
    }
    if (entry) {
      const yesno = entry.querySelector('.ashby-application-form-input-yesno')
      if (yesno) {
        const buttons = Array.from(yesno.querySelectorAll('button'))
        let empty = true
        for (const button of buttons) if (button.getAttribute('aria-pressed') === 'true') empty = false
        return empty
      }
      const combo = entry.querySelector('input[role="combobox"], input.ashby-application-form-input-autocomplete')
      if (combo instanceof HTMLInputElement) return !combo.value.trim() || /^start typing/i.test(combo.value)
      const area = entry.querySelector('textarea')
      if (area instanceof HTMLTextAreaElement) return !area.value.trim()
      const editable = entry.querySelector('[contenteditable="true"]')
      if (editable instanceof HTMLElement) return !(editable.innerText ?? '').trim()
      const select = entry.querySelector('select')
      if (select instanceof HTMLSelectElement) return !select.value
      const radios = Array.from(entry.querySelectorAll('input[type="radio"]'))
      if (radios.length) {
        let empty = true
        for (const radio of radios) if (radio instanceof HTMLInputElement && radio.checked) empty = false
        return empty
      }
      if (type === 'checkbox') {
        const checks = Array.from(entry.querySelectorAll('input[type="checkbox"]'))
        let empty = true
        let found = false
        for (const box of checks) {
          if (box.closest('.ashby-application-form-input-yesno')) continue
          if (!(box instanceof HTMLInputElement)) continue
          found = true
          if (box.checked) empty = false
        }
        if (found) return empty
      }
      const text = entry.querySelector('input:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"]):not([type="password"])')
      if (text instanceof HTMLInputElement) return !text.value.trim() || /^start typing/i.test(text.value)
    }
    if (name) {
      const named = document.querySelector(`[name="${CSS.escape(name)}"]`)
      if (named instanceof HTMLSelectElement) return !named.value
      if (named instanceof HTMLInputElement || named instanceof HTMLTextAreaElement) {
        if (named instanceof HTMLInputElement && (named.type === 'radio' || named.type === 'checkbox')) {
          const group = Array.from(document.querySelectorAll(`[name="${CSS.escape(name)}"]`))
          let empty = true
          for (const control of group) if (control instanceof HTMLInputElement && control.checked) empty = false
          return empty
        }
        return !named.value.trim() || /^start typing/i.test(named.value)
      }
    }
    let labeled: HTMLLabelElement | undefined
    for (const node of Array.from(document.querySelectorAll('label'))) {
      if (!(node instanceof HTMLLabelElement)) continue
      let text = (node.textContent ?? '').trim()
      text = text.replace(/\s+/g, ' ').replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/start typing\.\.\.?/gi, ' ').replace(/\*$/, '').trim().toLowerCase()
      if (text === wanted) { labeled = node; break }
    }
    const control = labeled?.htmlFor ? document.getElementById(labeled.htmlFor) : labeled?.querySelector('input,select,textarea,[contenteditable="true"]')
    if (control instanceof HTMLSelectElement) return !control.value
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) return !control.value.trim() || /^start typing/i.test(control.value)
    if (control instanceof HTMLElement && control.getAttribute('contenteditable') === 'true') return !(control.innerText ?? '').trim()
    return false
  }, { label: field.label, type: field.type, name: field.name ?? null, options: field.options ?? null, entrySel: ASHBY_FIELD_ENTRY_SEL }).catch(() => false)
}

export async function setValue(page: Page, field: FormField, value: string, place?: DropdownPlace): Promise<boolean> {
  try {
    if ((field.options?.some((option) => /^(yes|no)$/i.test(option)) || yesNoWanted(value)) && await setAshbyYesNo(page, field, value)) return true
    if (shouldFillDropdown(field)) return fillDropdown(page, field, value, place)
    if (field.type === 'radio' || (field.type === 'checkbox' && (field.options?.length ?? 0) > 1)) {
      let optionValue = field.options?.includes(value) ? value : yesNoWanted(value) ?? value
      if (field.options?.length && !field.options.includes(optionValue)) {
        const wanted = yesNoWanted(optionValue) ?? yesNoWanted(value)
        const match = wanted ? field.options.find((option) => yesNoWanted(option) === wanted) : undefined
        if (match) optionValue = match
      }
      if (!field.options?.includes(optionValue) && !yesNoWanted(optionValue) && !yesNoWanted(value)) return false
      const option = page.getByLabel(optionValue, {exact:true})
      const exact = field.name ? option.and(page.locator(`[name="${escapeAttributeValue(field.name)}"]`)).first() : page.getByRole('radiogroup',{name:field.label,exact:true}).getByRole('radio',{name:optionValue,exact:true}).or(option).first()
      if (await exact.isVisible().catch(() => false)) {
        await exact.check()
        return await exact.isChecked()
      }
      const choice = page.getByRole('button', { name: new RegExp(`^${optionValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).first()
      if (await choice.isVisible().catch(() => false)) {
        await choice.click()
        return true
      }
      const byText = page.getByText(optionValue, { exact: true }).first()
      if (await byText.isVisible().catch(() => false)) {
        await byText.click()
        if (!(await fieldLooksEmpty(page, field))) return true
      }
      return setValueInAshbyEntry(page, field, optionValue)
    }
    const control = controlFor(page, field)
    if ((await control.count()) === 0) return setValueInAshbyEntry(page, field, value)
    const role = await control.getAttribute('role').catch(() => null)
    const className = await control.getAttribute('class').catch(() => '')
    if (role === 'combobox' || /autocomplete/i.test(className ?? '')) return fillDropdown(page, field, value, place)
    if (!await control.isVisible()) return setValueInAshbyEntry(page, field, value)
    const credential = await control.evaluate(element => element instanceof HTMLInputElement && (element.type === 'password' || /^(current-password|new-password|one-time-code)$/.test(element.autocomplete)))
    if (credential) return false
    if (field.type === 'select-one' || field.type === 'select') {
      if (!value.trim() || /^select\b/i.test(value.trim())) return false
      try { await control.selectOption({ label: value }) }
      catch { await control.selectOption({ value }) }
      return control.evaluate((element) => element instanceof HTMLSelectElement && element.value !== '' && element.checkValidity())
    }
    if (field.type === 'checkbox') {
      if (!['true','false'].includes(value)) return false
      await control.setChecked(value === 'true')
      return (await control.isChecked()) === (value === 'true')
    }
    await control.fill(value)
    return true
  } catch {
    logger.debug({label:field.label}, 'control rejected the provided answer')
    return setValueInAshbyEntry(page, field, value)
  }
}

/** Attaches the résumé to whichever file input is asking for one. */
export async function attachResume(page: Page, resumePath: string): Promise<boolean> {
  let payload: Awaited<ReturnType<typeof browserFilePayload>>
  try { payload = await browserFilePayload(resumePath) }
  catch { return false }
  const trySet = async (input: ReturnType<Page['locator']>) => {
    try {
      await input.setInputFiles(payload, { timeout: 8_000 })
      const attached = typeof input.evaluate === 'function'
        ? await input.evaluate((element) => element instanceof HTMLInputElement && (element.files?.length ?? 0) > 0).catch(() => false)
        : true
      return attached
    } catch (error) {
      logger.warn({ err: error }, 'resume upload failed')
      return false
    }
  }
  const named = page.locator('input[type="file"][name*="resume" i], input[type="file"][id*="resume" i], input#resume')
  const namedCount = await named.count().catch(() => 0)
  for (let index = 0; index < namedCount; index += 1) {
      if (await trySet(named.nth(index))) {
        await waitUntilResumeParsed(page)
        return true
      }
  }
  const inputs = page.locator('input[type="file"]')
  const count = await inputs.count().catch(() => 0)
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index)
    const name = `${await input.getAttribute('name', { timeout: 2_000 }).catch(() => '') ?? ''} ${await input.getAttribute('id', { timeout: 2_000 }).catch(() => '') ?? ''}`
    const accept = await input.getAttribute('accept', { timeout: 2_000 }).catch(() => '') ?? ''
    if (/cover/i.test(name) && !/resume|cv/i.test(name)) continue
    if (/resume|cv/i.test(name) || /pdf|document|word/i.test(accept) || count === 1) {
      if (await trySet(input)) {
        await waitUntilResumeParsed(page)
        return true
      }
    }
  }
  const attach = typeof page.getByRole === 'function'
    ? page.getByRole('button', { name: /^(attach|upload file)$/i }).first()
    : null
  if (attach && (await attach.count()) > 0) {
    const chooser = page.waitForEvent('filechooser', { timeout: 4_000 }).catch(() => null)
    await attach.click().catch(() => undefined)
    const picked = await chooser
    if (picked) {
      await picked.setFiles({ name: payload.name, mimeType: payload.mimeType, buffer: payload.buffer })
      return true
    }
    const revealed = page.locator('input[type="file"]')
    if (await revealed.count()) {
      try { await revealed.first().setInputFiles(payload); return true } catch { return false }
    }
  }
  return false
}

export async function fillForm(params: {
  page: Page
  url: string
  userId: string
  attemptId: string
  profile: PortalProfile
  resumePath: string
  /** Where the candidate is and where the job is, for deriving work authorisation. */
  authorisation?: AuthorisationContext
}): Promise<FillResult> {
  const { page, url, userId, attemptId, profile, resumePath } = params

  const recipe: Recipe | null = recipeForPage(url, page.url())
  const plan = recipe ?? { ...GENERIC, id: 'generic', matches: () => true }

  if (recipe?.openForm) await recipe.openForm(page)

  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase()
    } catch {
      return 'unknown'
    }
  })()

  const fields = await readFields(page, plan.fieldContainer).catch(() => [] as FormField[])
  const filled: FilledField[] = []
  const unresolved: FillResult['unresolved'] = []

  for (const field of fields) {
    if (field.type === 'file') continue
    const mustFill = field.required || isReferralQuestion(field.label, field.options)

    const resolved = await resolveField(field, { userId, host, profile, ...(params.authorisation ? { authorisation: params.authorisation } : {}) })

    if (resolved.blocked) {
      // Only required fields stop an application. An optional question we
      // cannot answer is one we simply leave blank, as a person would.
      if (mustFill) {
        unresolved.push({ ...field, why: resolved.blocked })
      }
      filled.push({ label: field.label, via: 'skipped', filled: false })
      publishAttemptEvent(userId, {
        type: 'field',
        attemptId,
        label: field.label,
        via: 'skipped',
        filled: false,
      })
      continue
    }

    const ok = resolved.value ? await setValue(page, field, resolved.value, { city: profile.address.city, region: profile.address.region, country: profile.address.country }) : false
    if (!ok && mustFill) {
      unresolved.push({ ...field, why: 'needs_input' })
    }

    filled.push({ label: field.label, via: resolved.via, filled: ok })
    // The label and how it was resolved, never the value — a form field can
    // hold a phone number, and this goes over a socket.
    publishAttemptEvent(userId, {
      type: 'field',
      attemptId,
      label: field.label,
      via: resolved.via,
      filled: ok,
    })
  }

  const leftover = await readFields(page, plan.fieldContainer).catch(() => [] as FormField[])
  for (const field of leftover) {
    if (field.type === 'file') continue
    const mustFill = field.required || isReferralQuestion(field.label, field.options)
    if (filled.some((row) => row.label === field.label && row.filled)) continue
    if (!(await fieldLooksEmpty(page, field))) continue
    const resolved = await resolveField(field, { userId, host, profile, ...(params.authorisation ? { authorisation: params.authorisation } : {}) })
    if (resolved.blocked || !resolved.value) {
      if (resolved.blocked && mustFill && !unresolved.some((row) => row.label === field.label)) {
        unresolved.push({ ...field, why: resolved.blocked })
      }
      continue
    }
    const ok = await setValue(page, field, resolved.value, { city: profile.address.city, region: profile.address.region, country: profile.address.country })
    if (ok) {
      const index = unresolved.findIndex((row) => row.label === field.label)
      if (index >= 0) unresolved.splice(index, 1)
      filled.push({ label: field.label, via: resolved.via, filled: true })
      publishAttemptEvent(userId, { type: 'field', attemptId, label: field.label, via: resolved.via, filled: true })
    } else if (mustFill && !unresolved.some((row) => row.label === field.label)) {
      unresolved.push({ ...field, why: 'needs_input' })
    }
  }

  await attachResume(page, resumePath)

  return { fields: filled, unresolved, recipe: plan.id }
}

export async function pageLooksLikeNoForm(page: Page): Promise<boolean> {
  const url = page.url()
  if (/chrome-error:|ERR_TOO_MANY_REDIRECTS/i.test(url)) return true
  if (greenhousePostingGoneUrl(url)) return true
  if (/[?&]gh_jid=\d+/i.test(url) && !/greenhouse\.io/i.test(url)) return true
  if (greenhouseJobPathUrl(url)) return false
  const body = await page.locator('body').innerText().catch(() => '')
  if (/ERR_TOO_MANY_REDIRECTS|this page isn['’]t working|redirected you too many times|err_connection|err_name_not_resolved/i.test(body)) return true
  if (/current openings at\b/i.test(body) && /\b\d+\s+jobs\b/i.test(body)) return true
  const submit = await page.locator('#submit_app, #application_form, form#application-form, button:has-text("Submit Application")').count().catch(() => 0)
  if (submit > 0) return false
  const inputs = await page.locator('form input:not([type="hidden"]), form textarea, form select, .ashby-application-form-input-yesno').count().catch(() => 0)
  return inputs === 0 && (/\b\d+\s+jobs\b/i.test(body) || /current openings/i.test(body) || !body.trim())
}

async function waitUntilResumeParsed(page: Page): Promise<void> {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const text = await page.locator('body').innerText().catch(() => '')
    if (!/parsing your resume|submitting too early/i.test(text)) return
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

export async function formReady(page: Page, url: string): Promise<{ ok: boolean; notices: string[] }> {
  const body = await page.locator('body').innerText().catch(() => '')
  const notices = providerValidationFailed(body) ? [body.slice(0, 200)] : []
  if (await pageLooksLikeNoForm(page)) return { ok: false, notices }
  if (!(await hasSubmitControl({ page, url }))) return { ok: false, notices }
  let widgets = { emptyCombobox: false, emptyYesNo: false, emptySelect: false, emptyResume: false, emptyText: false }
  try {
    widgets = await page.evaluate((entrySel) => {
      const emptyCombobox = Array.from(document.querySelectorAll<HTMLInputElement>('input[role="combobox"], input.ashby-application-form-input-autocomplete, input[aria-autocomplete="list"]'))
        .some((input) => {
          const entry = input.closest(entrySel) || input.closest('fieldset')
          const labelEl = entry?.querySelector('label, .ashby-application-form-question-title')
          const labelText = labelEl?.textContent ?? ''
          const required = input.required
            || input.getAttribute('aria-required') === 'true'
            || /(?:[✱*]|\(required\))\s*$/i.test(labelText)
            || (labelEl ? /_required_/.test(String(labelEl.className)) : false)
            || entry?.querySelector('[class*="_required_"]') !== null
            || /\b(?:how|where)\s+did\s+you\s+(?:hear|learn|find)/i.test(labelText)
          if (!required) return false
          if (input.getAttribute('aria-invalid') === 'true') return true
          return !input.value.trim() || /^start typing/i.test(input.value)
        })
      const emptyYesNo = Array.from(document.querySelectorAll(entrySel)).some((entry) => {
        const required = /(?:[✱*]|\(required\))\s*$/i.test(entry.querySelector('label')?.textContent ?? '') || entry.querySelector('[class*="_required_"]') !== null
        const choices = entry.querySelectorAll('.ashby-application-form-input-yesno > button')
        return required && choices.length === 2 && Array.from(choices).every((button) => button.getAttribute('aria-pressed') !== 'true')
      })
      const emptySelect = Array.from(document.querySelectorAll<HTMLSelectElement>('select[required], select[aria-required="true"]'))
        .some((select) => !select.value)
      const emptyResume = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
        .some((input) => {
          const required = input.required || /resume|cv/i.test(`${input.name} ${input.id}`)
          return required && (input.files?.length ?? 0) === 0
        })
      const emptyText = Array.from(document.querySelectorAll(entrySel)).some((entry) => {
        const required = /(?:[✱*]|\(required\))\s*$/i.test(entry.querySelector('label')?.textContent ?? '') || entry.querySelector('[required], [aria-required="true"], [class*="_required_"]') !== null
        if (!required) return false
        const area = entry.querySelector('textarea')
        if (area instanceof HTMLTextAreaElement) return !area.value.trim()
        const editable = entry.querySelector('[contenteditable="true"]')
        if (editable instanceof HTMLElement) return !(editable.innerText ?? '').trim()
        return false
      })
      return { emptyCombobox, emptyYesNo, emptySelect, emptyResume, emptyText }
    }, ASHBY_FIELD_ENTRY_SEL)
  } catch {
    widgets = { emptyCombobox: false, emptyYesNo: false, emptySelect: false, emptyResume: false, emptyText: false }
  }
  if (widgets.emptyCombobox || widgets.emptyYesNo || widgets.emptySelect || widgets.emptyResume || widgets.emptyText) return { ok: false, notices }
  const recipe = recipeFor(url)
  const plan = recipe ?? { ...GENERIC, id: 'generic', matches: () => true }
  const submit = page.locator(plan.submit).first()
  const valid = await submit.evaluate((element) => {
    const form = element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element.form : element.closest('form')
    return !form || form.checkValidity()
  }).catch(() => true)
  if (!valid || notices.length) return { ok: false, notices }
  return { ok: true, notices }
}

export async function remeasureApplication(page: Page, url: string): Promise<{ unresolved: FillResult['unresolved']; canSubmit: boolean }> {
  if (await postingIsClosed(page, [url])) {
    return { canSubmit: false, unresolved: [{ label: 'This posting is no longer accepting applications.', type: 'automation', why: 'posting_closed' }] }
  }
  if (await pageLooksLikeNoForm(page)) {
    return { canSubmit: false, unresolved: [{ label: 'This page is a job listing or error page, not an application form.', type: 'automation', why: 'no_form' }] }
  }
  const ready = await formReady(page, url)
  if (ready.ok) return { unresolved: [], canSubmit: true }
  const recipe = recipeFor(url)
  const fields = await readFields(page, (recipe ?? GENERIC).fieldContainer).catch(() => [] as FormField[])
  const unresolved: FillResult['unresolved'] = []
  for (const field of fields) {
    if ((!field.required && !isReferralQuestion(field.label, field.options)) || field.type === 'file') continue
    if (await fieldLooksEmpty(page, field)) unresolved.push({ ...field, why: 'needs_input' })
  }
  if (!unresolved.length) {
    unresolved.push({ label: ready.notices[0] || 'Required fields are still empty.', type: 'text', why: 'needs_input' })
  }
  return { unresolved, canSubmit: false }
}

/**
 * A posting that has been taken down since it was scraped.
 *
 * Found by the first live dry run: a stored Ashby job answered with "Job not
 * found", the runtime reported `no_submit_control`, and the user would have
 * seen a confusing failure. It is not a failure — the job is simply gone, and
 * it should cost neither a slot in the daily budget nor a place in the review
 * queue.
 */
const POSTING_GONE =
  /\bjob\s+not\s+found\b|\bposition\s+(?:is\s+)?(?:no\s+longer|has\s+been)\s+(?:available|filled|closed)\b|\bno\s+longer\s+accepting\s+applications\b|\bthis\s+job\s+(?:posting\s+)?(?:is\s+)?(?:closed|expired)\b|\bposting\s+(?:is\s+)?closed\b/i

/** True when the page says the posting is gone rather than showing a form. */
export async function postingIsClosed(page: Page, extraUrls: Array<string | null | undefined> = []): Promise<boolean> {
  const urls = [page.url(), ...extraUrls].filter((url): url is string => Boolean(url))
  if (urls.some((url) => greenhousePostingGoneUrl(url))) return true
  for (const url of [...new Set(urls)]) {
    if (await greenhouseJobMissing(url)) return true
  }
  const body = await page.locator('body').innerText().catch(() => '')
  // Only trust it on a page with no form at all: a live posting can mention
  // "no longer accepting applications" about some *other* role in a sidebar.
  if (!POSTING_GONE.test(body)) return false
  const inputs = await page.locator('input:not([type="hidden"]), textarea, select').count().catch(() => 0)
  return inputs === 0
}

export async function checkRequiredConsentBoxes(page: Page): Promise<number> {
  let checked = 0
  const named = page.getByRole('checkbox', { name: /by checking this box/i })
  if (await named.count().catch(() => 0) > 0) {
    const box = named.first()
    await box.scrollIntoViewIfNeeded().catch(() => undefined)
    for (let step = 0; step < 3; step += 1) {
      const on = await box.isChecked().catch(() => false)
      if (step > 0 && on) {
        checked += 1
        break
      }
      await box.click({ timeout: 3_000, force: true }).catch(() => undefined)
    }
    if (await box.isChecked().catch(() => false) && checked === 0) checked += 1
    if (checked > 0) return checked
  }
  const consentLabel = page.locator('label, p, li, .field-wrapper, [role="checkbox"]').filter({ hasText: /by checking this box.{0,120}consent/i }).last()
  if (checked === 0 && await consentLabel.count().catch(() => 0) > 0) {
    const box = consentLabel.locator('input[type="checkbox"], [role="checkbox"]').first()
    await consentLabel.click({ timeout: 3_000, force: true }).catch(() => undefined)
    if (await box.count().catch(() => 0) > 0) {
      await box.click({ timeout: 3_000, force: true }).catch(() => undefined)
      if (await box.isChecked().catch(() => false)) checked += 1
    }
  }
  const boxes = page.locator('input[type="checkbox"]')
  const count = await boxes.count().catch(() => 0)
  for (let index = 0; index < count; index += 1) {
    const box = boxes.nth(index)
    const needsCheck = await box.evaluate((element) => {
      if (!(element instanceof HTMLInputElement)) return false
      const copy = (element.closest('label, li, .field-wrapper, p')?.textContent || '') + (element.getAttribute('aria-label') || '')
      return element.required || element.getAttribute('aria-required') === 'true' || /by checking this box|i consent|i agree/i.test(copy)
    }).catch(() => false)
    if (!needsCheck) continue
    for (let step = 0; step < 3; step += 1) {
      const on = await box.isChecked().catch(() => false)
      if (step > 0 && on) break
      await box.click({ timeout: 3_000, force: true }).catch(() => undefined)
    }
    if (await box.isChecked().catch(() => false)) checked += 1
  }
  return checked
}

export async function hasSubmissionConfirmation(page: Page, url: string) {
  const plan = recipeFor(url) ?? GENERIC
  return plan.success.test(await page.locator('body').innerText().catch(() => ''))
}

export interface SubmitResult {
  submitted: boolean
  /** Distinguishes a click whose server-side result could not be observed. */
  result?: 'submitted' | 'submitted_unconfirmed' | 'not_submitted' | 'provider_blocked'
  /** Set when we deliberately did not submit. */
  heldBack?: 'dry_run' | 'kill_switch' | 'no_submit_control' | 'posting_closed' | 'invalid_fields' | 'no_form'
  confirmation?: string
}

/** Whether the current recipe can see a usable submit control. */
export async function hasSubmitControl(params: { page: Page; url: string }): Promise<boolean> {
  const recipe = recipeFor(params.url)
  const plan = recipe ?? { ...GENERIC, id: 'generic', matches: () => true }
  const submit = params.page.locator(plan.submit).first()
  return (await submit.count()) > 0 && (await submit.isVisible().catch(() => false))
}

/**
 * The last step, and the only irreversible one.
 *
 * Dry run is the default, and the check happens *here* rather than at the
 * caller — one place, immediately before the click, so no future code path can
 * route around it.
 */
export async function submitForm(params: {
  page: Page
  url: string
  dryRun: boolean
  /** Extension leftover already measured empty. Skip Playwright widget emptiness. */
  skipWidgetReady?: boolean
}): Promise<SubmitResult> {
  const { page, url, dryRun, skipWidgetReady } = params
  const recipe = recipeFor(url)
  const plan = recipe ?? { ...GENERIC, id: 'generic', matches: () => true }

  if (env.APPLY_KILL_SWITCH) return { submitted: false, heldBack: 'kill_switch' }

  // Checked before looking for a submit control, so a dead posting reads as
  // "this job is gone" rather than "we could not find the button".
  if (await postingIsClosed(page)) return { submitted: false, heldBack: 'posting_closed' }
  if (await pageLooksLikeNoForm(page)) return { submitted: false, result: 'not_submitted', heldBack: 'no_form' }

  const submit = page.locator(plan.submit).first()
  if (!(await hasSubmitControl({ page, url }))) {
    return { submitted: false, heldBack: 'no_submit_control' }
  }

  await waitUntilResumeParsed(page)

  const valid=await submit.evaluate(element=>{const form=element instanceof HTMLButtonElement||element instanceof HTMLInputElement?element.form:element.closest('form');return !form||form.checkValidity()})
  if(!valid)return {submitted:false,result:'not_submitted',heldBack:'invalid_fields'}
  if (!skipWidgetReady) {
    const ready = await formReady(page, url)
    if (!ready.ok) return { submitted: false, result: 'not_submitted', heldBack: 'invalid_fields' }
  }

  if (dryRun) return { submitted: false, heldBack: 'dry_run' }

  const bodyBefore = await page.locator('body').innerText().catch(() => '')
  if (pageHasVerificationGate(bodyBefore) && !(await verificationInputsFilled(page))) {
    return { submitted: false, result: 'not_submitted', heldBack: 'invalid_fields' }
  }

  const beforeUrl = page.url()
  // Register before clicking so an immediate XHR response is not lost. A load
  // state that already happened must not win the race on a single-page form.
  const confirmation = page.waitForFunction(({source, flags}) => new RegExp(source, flags).test(document.body.innerText), {source:plan.success.source,flags:plan.success.flags}, {timeout:15_000})
  let durable = false
  const markDurable = async <T>(work: Promise<T>) => { const value = await work; durable = true; return value }
  const host = (() => { try { return new URL(beforeUrl).hostname } catch { return '' } })()
  const signals = Promise.any([
    markDurable(page.waitForURL((next) => next.toString() !== beforeUrl, {timeout:15_000})),
    markDurable(page.waitForSelector(plan.submit, {state:'detached',timeout:15_000})),
    markDurable(page.waitForResponse(response => {
      if (response.request().method() !== 'POST' || response.status() < 200 || response.status() >= 300) return false
      try {
        const responseHost = new URL(response.url()).hostname
        if (responseHost !== host) return false
        if (host.endsWith('ashbyhq.com')) return true
        return /apply|application|submit/i.test(new URL(response.url()).pathname)
      } catch { return false }
    }, {timeout:15_000})),
    markDurable(confirmation),
  ]).catch(() => undefined)
  await submit.click()
  await signals
  await confirmation.catch(() => undefined)
  const deadline = Date.now() + 4_000
  let body = await page.locator('body').innerText().catch(() => '')
  while (true) {
    if (providerSubmissionBlocked(body)) {
      await beforeSubmission()
      return { submitted: false, result: 'provider_blocked' }
    }
    if (plan.success.test(body)) {
      await beforeSubmission()
      return { submitted: true, result: 'submitted', confirmation: body.slice(0, 200) }
    }
    if (providerValidationFailed(body) && await hasSubmitControl({ page, url })) {
      return { submitted: false, result: 'not_submitted', heldBack: 'invalid_fields' }
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 400))
    body = await page.locator('body').innerText().catch(() => '')
  }
  await beforeSubmission()
  return { submitted: false, result: 'submitted_unconfirmed', confirmation: body.slice(0, 200) }
}
