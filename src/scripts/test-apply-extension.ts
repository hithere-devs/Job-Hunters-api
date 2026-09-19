import { emptyRequiredFields, ensureHuntlyApply, fillPageField, inventoryFields } from '../hunt/apply/extension-page.js'
import { serveApplyFixtures } from '../hunt/apply/extension-fixtures.js'
import { launchApplyExtensionContext } from '../hunt/browser.js'

/**
 * Local loop for the unpacked Huntly apply extension.
 *
 * Loads the real Chrome extension (not an injected script), opens the local
 * application fixture, fills it, and prints what the page script saw.
 *
 *   npm run apply-extension:test
 *   APPLY_EXTENSION_HEADED=1 npm run apply-extension:test
 */
const headed = process.env.APPLY_EXTENSION_HEADED === '1'
const fixtures = await serveApplyFixtures()
const launched = await launchApplyExtensionContext({ headed })
const page = launched.context.pages()[0] ?? await launched.context.newPage()
try {
  const url = `${fixtures.origin}/application.html`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await ensureHuntlyApply(page, { injectIfMissing: false })
  const fields = await inventoryFields(page, 'form')
  const plan = [
    { match: /full name/i, value: 'Ayan Mansoori' },
    { match: /email/i, value: 'ayan@example.com' },
    { match: /cover letter/i, value: 'Backend engineer applying for this role.' },
    { match: /location/i, value: 'Bengaluru', place: { city: 'Bengaluru', region: 'Karnataka', country: 'India' } },
    { match: /learn about this opportunity/i, value: 'LinkedIn' },
    { match: /authorized to work/i, value: 'No' },
    { match: /privacy notice/i, value: 'true' },
  ]
  const filled = []
  for (const step of plan) {
    const field = fields.find((item) => step.match.test(item.label))
    if (!field) {
      filled.push({ label: String(step.match), filled: false, error: 'missing from inventory' })
      continue
    }
    filled.push({
      label: field.label,
      type: field.type,
      required: field.required,
      filled: await fillPageField(page, field, step.value, 'place' in step ? step.place : undefined),
    })
  }
  const leftover = await emptyRequiredFields(page)
  const report = {
    url,
    extensionInjected: true,
    inventory: fields.map((field) => ({ label: field.label, type: field.type, required: field.required })),
    filled,
    leftover: leftover.map((field) => field.label),
    location: await page.locator('#loc').inputValue(),
    referral: await page.locator('[data-field-entry-id] input').inputValue(),
  }
  console.log(JSON.stringify(report, null, 2))
  if (leftover.length || filled.some((row) => !row.filled)) process.exitCode = 1
} finally {
  if (!headed) await launched.close()
  await fixtures.close()
  if (headed) {
    console.log('Headed Chrome still open. Ctrl+C when done.')
    await new Promise(() => undefined)
  }
}
