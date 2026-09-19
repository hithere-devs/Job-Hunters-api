import assert from 'node:assert/strict'
import { after, describe, it, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'
import { checkRequiredConsentBoxes } from './fill.js'
import {
  emailIsFromThisApply,
  extractGreenhouseEmailCode,
  fillVerificationCode,
  gmailRowTimeMs,
  gmailTabAmong,
  pageHasWrongSecurityCode,
  verificationInputsFilled,
} from './gmail-code.js'

test('extracts the 8-character Greenhouse code from the email body, not Gmail chrome', () => {
  const body = [
    'Inbox',
    'Google',
    'A verification code was sent to mywritingfrenzy@gmail.com.',
    'To submit your application, enter the 8-character code to confirm you\'re a human.',
    '',
    '7K2P9QMX',
    '',
    'Greenhouse',
  ].join('\n')
  assert.equal(extractGreenhouseEmailCode(body), '7K2P9QMX')
})

test('extracts a labeled Greenhouse security code', () => {
  assert.equal(
    extractGreenhouseEmailCode('Your verification code is: Ab12Cd34\nThanks for applying'),
    'Ab12Cd34',
  )
})

test('does not treat Inbox or Security as the code', () => {
  assert.equal(extractGreenhouseEmailCode('Inbox\nSecurity\nContinue\nGmail'), null)
})

test('reuses the already-open Gmail tab instead of inventing a new one', () => {
  const gmail = { url: () => 'https://mail.google.com/mail/u/0/#inbox' }
  const apply = { url: () => 'https://job-boards.greenhouse.io/reddit/jobs/1' }
  assert.equal(gmailTabAmong([apply, gmail]), gmail)
  assert.equal(gmailTabAmong([apply]), undefined)
})

test('only accepts Greenhouse emails timestamped after this apply started', () => {
  const start = Date.parse('Sat, Sep 19, 2026, 10:03:00 AM')
  assert.equal(emailIsFromThisApply(['Sat, Sep 19, 2026, 10:04 AM'], start, start + 60_000), true)
  assert.equal(emailIsFromThisApply(['Sat, Sep 19, 2026, 10:00 AM'], start, start + 60_000), false)
  assert.equal(emailIsFromThisApply(['Inbox', 'Google'], start, start + 60_000), false)
})

test('detects a rejected Greenhouse security code so we fetch the latest email', () => {
  assert.equal(pageHasWrongSecurityCode('Incorrect security code. Please try again.'), true)
  assert.equal(pageHasWrongSecurityCode('That code is invalid. Try a new code.'), true)
  assert.equal(pageHasWrongSecurityCode('A verification code was sent to mywritingfrenzy@gmail.com.'), false)
})

test('parses a same-day Gmail clock stamp', () => {
  const stamp = gmailRowTimeMs('10:04 AM', Date.parse('2026-09-19T15:10:00Z'))
  assert.equal(typeof stamp, 'number')
  assert.ok(stamp)
})

const chromePath = process.env.TEST_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser: Browser | null = await chromium.launch({ headless: true, executablePath: chromePath }).catch(() => null)

describe('Greenhouse security-code inputs', { skip: !browser }, () => {
  after(async () => { await browser?.close() })

  it('types the Greenhouse code with keypresses so a hidden required field updates', async () => {
    const page: Page = await browser!.newPage()
    await page.setContent(`<form id="application-form">
      <p>A verification code was sent. Enter the 8-character code to confirm you're a human.</p>
      <div id="boxes">${Array.from({ length: 8 }, (_, index) => `<input maxlength="1" class="otp" data-i="${index}">`).join('')}</div>
      <input id="secret" name="security_code" required tabindex="-1" aria-hidden="true" value="">
      <button type="submit">Submit application</button>
    </form>
    <script>
      const boxes = [...document.querySelectorAll('input.otp')]
      const secret = document.getElementById('secret')
      const sync = () => { secret.value = boxes.map((box) => box.value).join('') }
      boxes.forEach((box, index) => {
        box.addEventListener('keydown', (event) => {
          if (!event.isTrusted || event.key.length !== 1) return
          event.preventDefault()
          box.value = event.key
          sync()
          boxes[index + 1]?.focus()
        })
      })
    </script>`)
    try {
      assert.equal(await fillVerificationCode(page, 'Ab12Cd34'), true)
      assert.equal(await page.locator('#secret').inputValue(), 'Ab12Cd34')
      assert.equal(await page.locator('input.otp').nth(0).inputValue(), 'A')
      assert.equal(await page.locator('input.otp').nth(7).inputValue(), '4')
    } finally {
      await page.close()
    }
  })

  it('checks the required Reddit demographic consent box before submit', async () => {
    const page: Page = await browser!.newPage()
    await page.setContent(`<form>
      <label><input type="checkbox" required> By checking this box, I consent to Reddit collecting, storing, and processing my responses to the demographic data surveys above. *</label>
      <button type="submit">Submit application</button>
    </form>`)
    try {
      assert.equal(await page.locator('input[type="checkbox"]').isChecked(), false)
      assert.equal(await checkRequiredConsentBoxes(page), 1)
      assert.equal(await page.locator('input[type="checkbox"]').isChecked(), true)
    } finally {
      await page.close()
    }
  })

  it('trusted-clicks consent even when an untrusted fill left the native box lying-checked', async () => {
    const page: Page = await browser!.newPage()
    await page.setContent(`<form>
      <label>
        <input type="checkbox" required id="consent" aria-label="By checking this box, I consent to Reddit collecting">
        By checking this box, I consent to Reddit collecting, storing, and processing my responses to the demographic data surveys above.
      </label>
      <button type="submit">Submit application</button>
    </form>
    <script>
      const box = document.getElementById('consent')
      box.checked = true
      box.addEventListener('click', (event) => {
        if (!event.isTrusted) {
          event.preventDefault()
          box.checked = true
          box.removeAttribute('data-react')
          return
        }
        box.setAttribute('data-react', box.checked ? 'yes' : 'no')
      })
    </script>`)
    try {
      assert.equal(await page.locator('#consent').isChecked(), true)
      assert.equal(await page.locator('#consent').getAttribute('data-react'), null)
      assert.ok(await checkRequiredConsentBoxes(page) >= 1)
      assert.equal(await page.locator('#consent').getAttribute('data-react'), 'yes')
      assert.equal(await page.locator('#consent').isChecked(), true)
    } finally {
      await page.close()
    }
  })

  it('fills eight maxlength-1 boxes from the Gmail code', async () => {
    const page: Page = await browser!.newPage()
    await page.setContent(`<form>
      <p>Enter the 8-character code to confirm you're a human.</p>
      ${Array.from({ length: 8 }, (_, index) => `<input maxlength="1" id="c${index}">`).join('')}
    </form>`)
    try {
      assert.equal(await verificationInputsFilled(page), false)
      assert.equal(await fillVerificationCode(page, '7K2P9QMX'), true)
      assert.equal(await page.locator('#c0').inputValue(), '7')
      assert.equal(await page.locator('#c7').inputValue(), 'X')
      assert.equal(await verificationInputsFilled(page), true)
    } finally {
      await page.close()
    }
  })
})
