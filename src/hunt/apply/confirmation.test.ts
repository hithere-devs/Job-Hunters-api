import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { chromium, type Browser } from 'playwright-core'
import { invalidFormFields } from './form-validity.js'
import { addedText, atsFamily, capturePageState, classifySubmitOutcome, confirmationUrl, pageShowsConfirmation, siteOf, type NetworkEvent, type PageState } from './confirmation.js'

const form = (overrides: Partial<PageState> = {}): PageState => ({
  url: 'https://job-boards.greenhouse.io/acme/jobs/1',
  text: 'Senior Engineer\nAbout us\nThank you for your interest in Acme!\nFirst Name\nSubmit application',
  formPresent: true,
  submitVisible: true,
  invalidCount: 0,
  errorTexts: [],
  codeInputs: 0,
  ...overrides,
})
const post = (status: number, path = '/acme/jobs/1/applications'): NetworkEvent => ({ method: 'POST', url: `https://job-boards.greenhouse.io${path}`, status, sameSite: true, applicationLike: true })

describe('submit outcome classification', () => {
  it('a job description that says thank you is not a confirmation', () => {
    assert.equal(pageShowsConfirmation(form()), false)
    const result = classifySubmitOutcome({ before: form(), after: form(), network: [], ats: 'greenhouse' })
    assert.equal(result.outcome, 'rejected_validation')
  })
  it('confirms on the ATS confirmation URL', () => {
    const after = form({ url: 'https://job-boards.greenhouse.io/acme/jobs/1/confirmation', formPresent: false, submitVisible: false, text: 'Thank you for applying.' })
    assert.equal(classifySubmitOutcome({ before: form(), after, network: [post(200)], ats: 'greenhouse' }).outcome, 'confirmed')
  })
  it('confirms on new confirmation text once the form closes (Ashby keeps the URL)', () => {
    const before = form({ url: 'https://jobs.ashbyhq.com/acme/1/application' })
    const after = form({ url: before.url, formPresent: false, submitVisible: false, text: 'Thanks for applying!\nYour application was successfully submitted.' })
    assert.equal(classifySubmitOutcome({ before, after, network: [post(200, '/api/non-user-graphql')], ats: 'ashby' }).outcome, 'confirmed')
  })
  it('validation errors with the form still present are a provable rejection', () => {
    const after = form({ invalidCount: 2, errorTexts: ['This field is required.'] })
    assert.equal(classifySubmitOutcome({ before: form(), after, network: [], ats: 'greenhouse' }).outcome, 'rejected_validation')
  })
  it('a 422 from the ATS with the form still present is a rejection', () => {
    assert.equal(classifySubmitOutcome({ before: form(), after: form(), network: [post(422)], ats: 'greenhouse' }).outcome, 'rejected_validation')
  })
  it('an accepted request with no confirmation is uncertain, never a success', () => {
    const after = form({ formPresent: false, submitVisible: false, text: 'Loading…' })
    assert.equal(classifySubmitOutcome({ before: form(), after, network: [post(201)], ats: 'greenhouse' }).outcome, 'uncertain')
  })
  it('recognises the Greenhouse emailed-code gate', () => {
    const after = form({ text: `${form().text}\nA verification code was sent to your email. Enter the 8-character code.`, codeInputs: 8 })
    assert.equal(classifySubmitOutcome({ before: form(), after, network: [post(200)], ats: 'greenhouse' }).outcome, 'verification_required')
  })
  it('recognises the provider spam rejection', () => {
    const after = form({ text: "We couldn't submit your application. Your application submission was flagged as possible spam." })
    assert.equal(classifySubmitOutcome({ before: form(), after, network: [post(200)], ats: 'ashby' }).outcome, 'provider_blocked')
  })
  it('a CAPTCHA challenge instead of a submission is captcha_required, not a validation error', () => {
    assert.equal(classifySubmitOutcome({ before: form(), after: form({ captchaChallenge: true }), network: [], ats: 'ashby' }).outcome, 'captcha_required')
  })
  it('pending writes leave the outcome uncertain', () => {
    assert.equal(classifySubmitOutcome({ before: form(), after: form(), network: [post(0)], ats: 'greenhouse' }).outcome, 'uncertain')
  })
})

describe('confirmation helpers', () => {
  it('detects ATS families and sites', () => {
    assert.equal(atsFamily('https://jobs.lever.co/x/1'), 'lever')
    assert.equal(siteOf('https://boards-api.greenhouse.io/v1'), 'greenhouse.io')
    assert.equal(siteOf('https://careers.example.co.uk/jobs'), 'example.co.uk')
  })
  it('matches confirmation URLs per ATS', () => {
    assert.equal(confirmationUrl('https://jobs.lever.co/acme/123/thanks'), true)
    assert.equal(confirmationUrl('https://jobs.lever.co/acme/123/apply'), false)
  })
  it('diffs only new lines', () => {
    assert.equal(addedText('a\nb', 'a\nb\nc'), 'c')
  })
})

const chromePath = process.env.TEST_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser: Browser | null = await chromium.launch({ headless: true, executablePath: chromePath }).catch(() => null)

describe('challenge frames on screen', { skip: !browser }, () => {
  after(async () => { await browser?.close() })
  it('a Greenhouse checkbox group with one box ticked is satisfied; an empty required field is named', async () => {
    const page = await browser!.newPage()
    try {
      await page.setContent(`<form><fieldset><legend>How should we communicate with you?</legend>
        <label><input type="checkbox" name="q[]" value="1" required checked>Email</label>
        <label><input type="checkbox" name="q[]" value="2" required>Phone Call</label></fieldset>
        <label for="city">City</label><input id="city" name="city" required>
        <button type="submit">Submit application</button></form>`)
      const invalid = await invalidFormFields(page, 'button[type=submit]')
      assert.equal(invalid.length, 1)
      assert.match(invalid[0]!, /^City:/)
      await page.fill('#city', 'Bengaluru')
      assert.deepEqual(await invalidFormFields(page, 'button[type=submit]'), [])
    } finally {
      await page.close()
    }
  })
  it('counts the Cloudflare Turnstile checkbox (Workable) but not an invisible reCAPTCHA badge', async () => {
    const page = await browser!.newPage()
    await page.route('**/*', (route) => route.request().url().startsWith('https://') ? route.fulfill({ body: '<html></html>' }) : route.continue())
    try {
      await page.setContent(`<form><input name="a"><input name="b"><button type="submit">Submit application</button>
        <iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc" style="width:300px;height:65px;border:0"></iframe></form>`)
      assert.equal((await capturePageState(page, 'button[type=submit]')).captchaChallenge, true)
      await page.setContent(`<form><input name="a"><input name="b"><button type="submit">Submit application</button>
        <iframe src="https://www.google.com/recaptcha/api2/anchor?k=x" style="width:256px;height:60px;border:0"></iframe></form>`)
      assert.equal((await capturePageState(page, 'button[type=submit]')).captchaChallenge, false)
    } finally {
      await page.close()
    }
  })
})
