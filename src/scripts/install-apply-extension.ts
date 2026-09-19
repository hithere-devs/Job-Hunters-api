import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { emptyRequiredFields, ensureHuntlyApply, fillPageField, inventoryFields } from '../hunt/apply/extension-page.js'
import { serveApplyFixtures } from '../hunt/apply/extension-fixtures.js'
import { launchLaptopChromeWithExtension } from '../hunt/apply/laptop-chrome.js'

/**
 * Load Huntly Apply unpacked into laptop Google Chrome, then fill the local
 * application fixture. Chrome window stays open.
 *
 *   npm run apply-extension:install
 */
const launched = await launchLaptopChromeWithExtension()
const fixtures = await serveApplyFixtures()
const proofDir = path.join(launched.profileDir, 'proof')
await mkdir(proofDir, { recursive: true })
const page = launched.page

try {
  await page.goto('chrome://extensions/', { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined)
  await page.screenshot({ path: path.join(proofDir, 'extensions.png') }).catch(() => undefined)

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
  await page.screenshot({ path: path.join(proofDir, 'filled.png'), fullPage: true })
  const report = {
    chrome: 'Google Chrome',
    extensionId: launched.extensionId,
    profileDir: launched.profileDir,
    url,
    inventory: fields.map((field) => ({ label: field.label, type: field.type, required: field.required })),
    filled,
    leftover: leftover.map((field) => field.label),
    location: await page.locator('#loc').inputValue(),
    referral: await page.locator('[data-field-entry-id] input').inputValue(),
    proof: {
      extensions: path.join(proofDir, 'extensions.png'),
      filled: path.join(proofDir, 'filled.png'),
    },
  }
  console.log(JSON.stringify(report, null, 2))
  if (leftover.length || filled.some((row) => !row.filled)) process.exitCode = 1
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exitCode = 1
} finally {
  await launched.disconnect()
  console.log(`Chrome left open. Huntly Apply unpacked in ${launched.profileDir}`)
  console.log('Fixture server stays up. Ctrl+C to stop the server (Chrome keeps running).')
  process.on('SIGINT', async () => {
    await fixtures.close()
    process.exit(process.exitCode ?? 0)
  })
  await new Promise(() => undefined)
}
