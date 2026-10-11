const { chromium } = await import('playwright-core')
const pilot = await import('../../hunt/apply/pilot-page.js')
const headless = process.argv[2] !== 'headful'
const browser = await chromium.launch({ headless, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US' })
await ctx.addInitScript({ content: pilot.applyPilotSource() })
const page = await ctx.newPage()
await page.goto('https://jobs.ashbyhq.com/cursor/c1ac67d4-645a-4632-a178-ea6b5f49bb26/application', { waitUntil: 'domcontentloaded', timeout: 45000 })
for (const wait of [2000, 5000, 10000]) {
  await page.waitForTimeout(wait)
  const snap = await pilot.snapshotPage(page)
  console.log(`after +${wait}ms: url=${page.url()} elements=${snap.elements.length} looksLikeForm=${snap.looksLikeForm}`)
  console.log('  ', snap.elements.slice(0, 14).map(e => `${e.role}:${e.label.slice(0, 30)}`).join(' | '))
  console.log('  text:', snap.text.slice(0, 200).replace(/\n/g, ' '))
}
console.log('submit buttons:', await page.locator('button:has-text("Submit")').count(), 'ua:', await page.evaluate(() => navigator.userAgent))
await page.screenshot({ path: '/tmp/ashby-probe.png' })
await browser.close(); process.exit(0)
