const { chromium } = await import('playwright-core')
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
for (const org of ['cursor', 'linear', 'mercor', 'openai', 'ramp', 'notion']) {
  const board = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${org}`).then(r => r.json()).catch(() => null) as { jobs?: Array<{ applyUrl: string }> } | null
  const url = board?.jobs?.[0]?.applyUrl
  if (!url) { console.log(org, 'no board'); continue }
  const page = await browser.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined)
  await page.waitForTimeout(6000)
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 80).replace(/\n/g, ' ')
  const inputs = await page.locator('input:not([type=hidden]), textarea').count()
  console.log(`${org.padEnd(8)} inputs=${String(inputs).padStart(2)} text="${text}"`)
  await page.close()
}
await browser.close(); process.exit(0)
