import type { Page } from 'playwright-core'

/**
 * Cookie dialogs (Workable, many career sites) lay a backdrop over the form,
 * so clicks land on the backdrop instead of the field or submit button. Take
 * the privacy-preserving choice: decline optional cookies. A dialog that only
 * offers "Accept" is left alone.
 */
const DECLINE = /^\s*(?:decline all|decline|reject all|reject|refuse all|deny all|deny|only necessary|necessary only|essential only|only essential|use necessary cookies only|reject optional cookies|decline optional cookies|continue without accepting)\s*$/i

export async function declineCookieBanner(page: Page, waitMs = 0): Promise<boolean> {
  const deadline = Date.now() + waitMs
  do {
    const buttons = page.getByRole('button', { name: DECLINE })
    const count = await buttons.count().catch(() => 0)
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index)
      if (!await button.isVisible().catch(() => false)) continue
      if (await button.click({ timeout: 2_000 }).then(() => true, () => false)) return true
    }
    if (Date.now() >= deadline) break
    await page.waitForTimeout(500).catch(() => undefined)
  } while (Date.now() < deadline)
  return false
}
