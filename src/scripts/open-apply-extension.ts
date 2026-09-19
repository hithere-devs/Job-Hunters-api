import { ensureHuntlyApply, inventoryFields } from '../hunt/apply/extension-page.js'
import { serveApplyFixtures } from '../hunt/apply/extension-fixtures.js'
import { launchApplyExtensionContext } from '../hunt/browser.js'

/**
 * Headed Chrome with the unpacked Huntly apply extension.
 *
 *   npm run apply-extension:open
 *   npm run apply-extension:open -- https://jobs.ashbyhq.com/...
 */
const target = process.argv[2]
const fixtures = target ? null : await serveApplyFixtures()
const launched = await launchApplyExtensionContext({ headed: true })
const page = launched.context.pages()[0] ?? await launched.context.newPage()
const url = target || `${fixtures!.origin}/application.html`
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
try {
  await ensureHuntlyApply(page, { injectIfMissing: false })
  const fields = await inventoryFields(page)
  console.log(JSON.stringify({
    url: page.url(),
    extensionInjected: true,
    fields: fields.map((field) => ({ label: field.label, type: field.type, required: field.required })),
  }, null, 2))
} catch (error) {
  console.log(JSON.stringify({
    url: page.url(),
    extensionInjected: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2))
}
console.log('Chrome open with Huntly Apply. Ctrl+C to quit.')
process.on('SIGINT', async () => {
  await launched.close()
  await fixtures?.close()
  process.exit(0)
})
await new Promise(() => undefined)
