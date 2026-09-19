import { chromium } from 'playwright-core'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const zipPath = path.join(root, 'dist/huntly-apply-0.1.0.zip')
const iconPath = path.join(root, 'apply-extension/store/icon-128.png')
const screenshotPath = path.join(root, 'apply-extension/store/screenshot-1280x800.png')
const promoPath = path.join(root, 'apply-extension/store/promo-440x280.png')
const privacyUrl = 'https://gist.github.com/hithere-devs/034490db543887ab8ff494b92d8dccb1'
const publisher = 'ea8613a5-17e5-4dd5-bcb2-4978f0714216'
const dashboard = `https://chrome.google.com/webstore/devconsole/${publisher}`

const description = `Huntly Apply fills job application forms Huntly already resolved.

It runs on Greenhouse, Lever, Ashby, SmartRecruiters, Workable, and employer career pages after Huntly opens the live apply URL. The extension inventories fields in the page, writes answers keyed by those fields, and leaves submit to Huntly.

This listing is the same code Huntly loads unpacked for apply automation. It does not submit the form by itself, does not inject ads, and does not phone home.`

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const contexts = browser.contexts()
  const pages = contexts.flatMap((context) => context.pages())
  let page = pages.find((candidate) => candidate.url().includes('webstore/devconsole')) ?? pages[0]
  if (!page) throw new Error('No Chrome pages on CDP 9222')
  await page.bringToFront()
  if (!page.url().includes('webstore/devconsole')) {
    await page.goto(dashboard, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  }
  await page.waitForTimeout(2500)
  const signedOut = /accounts\.google\.com|Sign in/i.test(await page.content()) || /Sign in/i.test(await page.locator('body').innerText().catch(() => ''))
  if (signedOut && page.url().includes('accounts.google.com')) {
    throw new Error(`Dashboard signed out: ${page.url()}`)
  }

  const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000)
  console.log(JSON.stringify({ url: page.url(), title: await page.title(), body: body.slice(0, 1500) }, null, 2))

  const addNew = page.getByRole('button', { name: /add new item|new item|upload new package/i }).first()
  if (await addNew.count()) {
    await addNew.click({ timeout: 15_000 })
    await page.waitForTimeout(1500)
  }

  const file = page.locator('input[type="file"]').first()
  await file.waitFor({ state: 'attached', timeout: 20_000 })
  await file.setInputFiles(zipPath)
  await page.waitForTimeout(4000)

  const upload = page.getByRole('button', { name: /^upload$/i }).first()
  if (await upload.count()) await upload.click().catch(() => undefined)

  await page.waitForTimeout(5000)
  console.log(JSON.stringify({ afterUpload: page.url(), text: (await page.locator('body').innerText()).slice(0, 2000) }, null, 2))

  const listing = page.getByRole('link', { name: /store listing/i }).first()
  if (await listing.count()) await listing.click().catch(() => undefined)
  await page.waitForTimeout(1500)

  const detailed = page.getByLabel(/detailed description|description/i).first()
  if (await detailed.count()) {
    await detailed.fill(description).catch(() => undefined)
  }

  for (const [label, filePath] of [
    [/store icon|128.?128/i, iconPath],
    [/screenshot/i, screenshotPath],
    [/small promo|440.?280/i, promoPath],
  ] as const) {
    const slot = page.getByRole('button', { name: label }).or(page.getByText(label)).locator('xpath=ancestor::*[.//input[@type="file"]][1]//input[@type="file"]').first()
    if (await slot.count()) await slot.setInputFiles(filePath).catch(() => undefined)
  }

  const privacyLink = page.getByRole('link', { name: /privacy/i }).first()
  if (await privacyLink.count()) await privacyLink.click().catch(() => undefined)
  await page.waitForTimeout(1000)

  const policy = page.getByLabel(/privacy policy/i).first()
  if (await policy.count()) await policy.fill(privacyUrl).catch(() => undefined)

  const single = page.getByLabel(/single purpose|single-purpose/i).first()
  if (await single.count()) {
    await single.fill('Fill job application form fields on ATS and employer career pages for Huntly apply runs.').catch(() => undefined)
  }

  const hostJust = page.getByLabel(/host.?permission|host access/i).first()
  if (await hostJust.count()) {
    await hostJust.fill('Job applications live on employer and ATS domains. The extension fills only the open apply form during a Huntly run.').catch(() => undefined)
  }

  console.log(JSON.stringify({ doneUrl: page.url(), text: (await page.locator('body').innerText()).slice(0, 2500) }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exit(1)
})
