import type { Page } from 'playwright-core'

/**
 * Fields the browser's constraint check refuses, named, for the form that owns
 * the submit control.
 *
 * Greenhouse marks every box of a checkbox group `required`; the browser does
 * not group checkboxes, so with "Email" ticked the other boxes still read as
 * invalid and `form.checkValidity()` is false. Its own script validates the
 * group as a whole. A required box whose same-name group has a ticked box is
 * therefore satisfied.
 */
export async function invalidFormFields(page: Page, submitSelector: string): Promise<string[]> {
  return page.locator(submitSelector).first().evaluate((node) => {
    const form = node instanceof HTMLButtonElement || node instanceof HTMLInputElement ? node.form : node.closest('form')
    if (!form || form.checkValidity()) return []
    return Array.from(form.querySelectorAll('input, select, textarea'))
      .filter((element) => {
        const input = element as HTMLInputElement
        if (input.validity.valid) return false
        if (input.type === 'checkbox' && input.name) {
          const group = Array.from(form.querySelectorAll('input[type="checkbox"]')).filter((box) => (box as HTMLInputElement).name === input.name)
          if (group.length > 1 && group.some((box) => (box as HTMLInputElement).checked)) return false
        }
        return true
      })
      .slice(0, 8)
      .map((element) => {
        const input = element as HTMLInputElement
        const label = (input.labels?.[0]?.textContent ?? input.closest('fieldset')?.querySelector('legend')?.textContent ?? input.getAttribute('aria-label') ?? input.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80)
        return `${label}: ${input.validationMessage}`
      })
  }).catch(() => [] as string[])
}
