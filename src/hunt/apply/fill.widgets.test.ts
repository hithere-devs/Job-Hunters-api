import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'
import { attachResume, fieldLooksEmpty, formReady, remeasureApplication, setValue } from './fill.js'
import { impliedConsentValue } from './fields.js'
import { readFields } from './recipes.js'

const chromePath = process.env.TEST_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser: Browser | null = await chromium.launch({ headless: true, executablePath: chromePath }).catch(() => null)

async function gotoHtml(html: string): Promise<Page> {
  const page = await browser!.newPage()
  await page.setContent(html, { waitUntil: 'domcontentloaded' })
  return page
}

describe('ATS widget adapters', { skip: !browser }, () => {
  after(async () => { await browser?.close() })

  it('clicks the matching Ashby Yes/No button and ignores the hidden checkbox', async () => {
    const page = await gotoHtml(`<form>
      <div class="ashby-application-form-field-entry">
        <label>Are you legally authorized to work in the United States?*</label>
        <div class="ashby-application-form-input-yesno">
          <button type="button" aria-pressed="false">Yes</button>
          <button type="button" aria-pressed="false">No</button>
          <input type="checkbox" style="display:none">
        </div>
      </div>
      <button type="submit">Submit Application</button>
    </form>
    <script>
      document.querySelectorAll('.ashby-application-form-input-yesno > button').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.preventDefault()
          document.querySelectorAll('.ashby-application-form-input-yesno > button').forEach((other) => other.setAttribute('aria-pressed', other === button ? 'true' : 'false'))
        })
      })
    </script>`)
    try {
      const ok = await setValue(page, {
        label: 'Are you legally authorized to work in the United States?*',
        type: 'checkbox',
        required: true,
        options: ['Yes', 'No'],
      }, 'No')
      assert.equal(ok, true)
      assert.equal(await page.locator('.ashby-application-form-input-yesno > button', { hasText: 'No' }).getAttribute('aria-pressed'), 'true')
      assert.equal(await page.locator('.ashby-application-form-input-yesno > button', { hasText: 'Yes' }).getAttribute('aria-pressed'), 'false')
    } finally { await page.close() }
  })

  it('commits an Ashby combobox and treats leftover Start typing as not ready', async () => {
    const page = await gotoHtml(`<form>
      <div class="ashby-application-form-field-entry">
        <label for="hear">How did you hear about us?*</label>
        <input id="hear" class="ashby-application-form-input-autocomplete" role="combobox" required placeholder="Start typing...">
      </div>
      <div class="ashby-application-form-input-autocomplete-popup-result">LinkedIn</div>
      <button type="submit">Submit Application</button>
    </form>`)
    try {
      assert.equal((await formReady(page, 'https://jobs.ashbyhq.com/fixture/application')).ok, false)
      const ok = await setValue(page, {
        label: 'How did you hear about us?*',
        type: 'combobox',
        required: true,
      }, 'LinkedIn')
      assert.equal(ok, true)
      assert.equal(await page.locator('input.ashby-application-form-input-autocomplete').inputValue(), 'LinkedIn')
      assert.equal((await formReady(page, 'https://jobs.ashbyhq.com/fixture/application')).ok, true)
    } finally { await page.close() }
  })

  it('attaches a Greenhouse resume through the hidden file input, not Attach', async () => {
    const page = await gotoHtml(`<form>
      <label>Resume/CV<input id="resume" name="resume" type="file" accept="application/pdf" style="display:none" required></label>
      <button type="button" id="attach">Attach</button>
      <label>Gender
        <select required>
          <option value="">Select...</option>
          <option value="decline">Decline to self identify</option>
        </select>
      </label>
      <button id="submit_app" type="submit">Submit Application</button>
    </form>`)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'resume-widget-'))
    const file = path.join(dir, 'resume.pdf')
    await writeFile(file, '%PDF-1.4 fixture')
    await page.locator('#attach').evaluate((button) => {
      button.addEventListener('click', () => { (window as unknown as { attachClicks?: number }).attachClicks = ((window as unknown as { attachClicks?: number }).attachClicks ?? 0) + 1 })
    })
    try {
      assert.equal(await attachResume(page, file), true)
      assert.equal(await page.evaluate(() => (window as unknown as { attachClicks?: number }).attachClicks ?? 0), 0)
      assert.equal(await page.locator('#resume').evaluate((input) => input instanceof HTMLInputElement && (input.files?.length ?? 0) > 0), true)
      assert.equal(await setValue(page, { label: 'Gender', type: 'select-one', required: true }, 'Select...'), false)
      assert.equal(await setValue(page, { label: 'Gender', type: 'select-one', required: true }, 'Decline to self identify'), true)
    } finally {
      await page.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('extracts Ashby field-entry widgets and fills cover letter, SMS/WhatsApp, and referral', async () => {
    const page = await gotoHtml(`<form>
      <div class="ashby-application-form-field-entry">
        <label>Cover Letter*</label>
        <textarea required></textarea>
      </div>
      <div class="ashby-application-form-field-entry">
        <label>Yes - I consent to receiving SMS text messages</label>
        <input type="radio">
      </div>
      <div class="ashby-application-form-field-entry">
        <label>No - I do not consent to receiving SMS text messages</label>
        <input type="radio">
      </div>
      <div class="ashby-application-form-field-entry">
        <label>Yes - I consent to receiving WhatsApp messages</label>
        <input type="radio">
      </div>
      <div class="ashby-application-form-field-entry">
        <label>No - I do not consent to receiving WhatsApp messages</label>
        <input type="radio">
      </div>
      <div class="ashby-application-form-field-entry">
        <label>How did you hear about this job?*</label>
        <input class="ashby-application-form-input-autocomplete" role="combobox" required placeholder="Start typing...">
      </div>
      <div class="ashby-application-form-input-autocomplete-popup-result">Job board</div>
      <button type="submit">Submit Application</button>
    </form>`)
    try {
      const fields = await readFields(page, 'form')
      const labels = fields.map((field) => field.label)
      assert.ok(labels.some((label) => /cover letter/i.test(label)), labels.join(' | '))
      assert.ok(labels.includes('SMS text message consent'), labels.join(' | '))
      assert.ok(labels.includes('WhatsApp message consent'), labels.join(' | '))
      assert.ok(labels.some((label) => /how did you hear about this job/i.test(label)), labels.join(' | '))
      assert.equal(labels.some((label) => /^start typing/i.test(label)), false)
      const sms = fields.find((field) => field.label === 'SMS text message consent')!
      assert.equal(impliedConsentValue(sms)?.startsWith('No'), true)
      const leftover = await remeasureApplication(page, 'https://jobs.ashbyhq.com/fixture/application')
      assert.equal(leftover.canSubmit, false)
      assert.ok(leftover.unresolved.some((field) => /cover letter|how did you hear/i.test(field.label)), leftover.unresolved.map((field) => field.label).join(' | '))
      assert.equal(leftover.unresolved.some((field) => field.label === 'Required fields are still empty.'), false)
      assert.equal(await setValue(page, fields.find((field) => /cover letter/i.test(field.label))!, 'My experience includes working as Engineer at PriorCo.'), true)
      assert.equal(await setValue(page, sms, impliedConsentValue(sms)!), true)
      const whatsapp = fields.find((field) => field.label === 'WhatsApp message consent')!
      assert.equal(await setValue(page, whatsapp, impliedConsentValue(whatsapp)!), true)
      const referral = fields.find((field) => /how did you hear/i.test(field.label))!
      assert.equal(await setValue(page, referral, 'Job board'), true)
      assert.equal(await fieldLooksEmpty(page, fields.find((field) => /cover letter/i.test(field.label))!), false)
      assert.equal(await fieldLooksEmpty(page, sms), false)
      assert.equal(await fieldLooksEmpty(page, referral), false)
      assert.equal((await formReady(page, 'https://jobs.ashbyhq.com/fixture/application')).ok, true)
      assert.equal((await remeasureApplication(page, 'https://jobs.ashbyhq.com/fixture/application')).canSubmit, true)
    } finally { await page.close() }
  })

  it('commits a location typeahead by clicking the matching option, not the typed stub', async () => {
    const page = await gotoHtml(`<form>
      <div class="ashby-application-form-field-entry">
        <label for="loc">Location*</label>
        <input id="loc" class="ashby-application-form-input-autocomplete" role="combobox" required placeholder="Start typing..." aria-invalid="true">
      </div>
      <div id="popup"></div>
      <button type="submit">Submit Application</button>
    </form>
    <script>
      const input = document.getElementById('loc')
      const popup = document.getElementById('popup')
      const cities = ['Bengaluru, Karnataka, India', 'Berlin, Germany']
      input.addEventListener('input', () => {
        popup.innerHTML = ''
        const query = input.value.trim().toLowerCase()
        input.setAttribute('aria-invalid', 'true')
        if (!query) return
        for (const city of cities) {
          if (!city.toLowerCase().includes(query)) continue
          const option = document.createElement('div')
          option.setAttribute('role', 'option')
          option.className = 'ashby-application-form-input-autocomplete-popup-result'
          option.textContent = city
          option.addEventListener('mousedown', (event) => {
            event.preventDefault()
            input.value = city
            input.setAttribute('aria-invalid', 'false')
            popup.innerHTML = ''
          })
          popup.appendChild(option)
        }
      })
    </script>`)
    try {
      assert.equal((await formReady(page, 'https://jobs.ashbyhq.com/fixture/application')).ok, false)
      const ok = await setValue(page, { label: 'Location*', type: 'combobox', required: true }, 'Bengaluru', {
        city: 'Bengaluru',
        region: 'Karnataka',
        country: 'India',
      })
      assert.equal(ok, true)
      assert.equal(await page.locator('#loc').inputValue(), 'Bengaluru, Karnataka, India')
      assert.equal(await page.locator('#loc').getAttribute('aria-invalid'), 'false')
      assert.equal((await formReady(page, 'https://jobs.ashbyhq.com/fixture/application')).ok, true)
    } finally { await page.close() }
  })

  it('picks LinkedIn from a how-did-you-hear list when Job board is absent', async () => {
    const page = await gotoHtml(`<form>
      <div class="ashby-application-form-field-entry">
        <label for="hear">How did you hear about this job?*</label>
        <input id="hear" class="ashby-application-form-input-autocomplete" role="combobox" required placeholder="Start typing...">
      </div>
      <div id="popup"></div>
      <button type="submit">Submit Application</button>
    </form>
    <script>
      const input = document.getElementById('hear')
      const popup = document.getElementById('popup')
      const sources = ['LinkedIn', 'Indeed', 'Other']
      input.addEventListener('input', () => {
        popup.innerHTML = ''
        const query = input.value.trim().toLowerCase()
        if (!query) return
        for (const source of sources) {
          const option = document.createElement('div')
          option.setAttribute('role', 'option')
          option.className = 'ashby-application-form-input-autocomplete-popup-result'
          option.textContent = source
          option.addEventListener('mousedown', (event) => {
            event.preventDefault()
            input.value = source
            popup.innerHTML = ''
          })
          popup.appendChild(option)
        }
      })
    </script>`)
    try {
      const ok = await setValue(page, { label: 'How did you hear about this job?*', type: 'combobox', required: true }, 'Job board')
      assert.equal(ok, true)
      assert.equal(await page.locator('#hear').inputValue(), 'LinkedIn')
    } finally { await page.close() }
  })

  it('selects a native country option by fuzzy label', async () => {
    const page = await gotoHtml(`<form>
      <label>Country
        <select required>
          <option value="">Select...</option>
          <option value="IN">India</option>
          <option value="US">United States</option>
        </select>
      </label>
      <button type="submit">Submit Application</button>
    </form>`)
    try {
      assert.equal(await setValue(page, { label: 'Country', type: 'select-one', required: true }, 'India'), true)
      assert.equal(await page.locator('select').inputValue(), 'IN')
    } finally { await page.close() }
  })

  it('fills an Ashby contenteditable cover letter from the field-entry inventory', async () => {
    const page = await gotoHtml(`<form>
      <div class="ashby-application-form-field-entry">
        <label>Cover Letter*</label>
        <div contenteditable="true" aria-required="true"></div>
      </div>
      <button type="submit">Submit Application</button>
    </form>`)
    try {
      const fields = await readFields(page, 'form')
      const cover = fields.find((field) => /cover letter/i.test(field.label))
      assert.ok(cover)
      assert.equal(cover!.type, 'textarea')
      assert.equal(await setValue(page, cover!, 'My professional background is Backend Engineer.'), true)
      assert.equal(await page.locator('[contenteditable="true"]').innerText(), 'My professional background is Backend Engineer.')
      assert.equal(await fieldLooksEmpty(page, cover!), false)
    } finally { await page.close() }
  })

  it('extracts and commits Ashby hashed how-did-you-learn combobox without field-entry class', async () => {
    const page = await gotoHtml(`<form>
      <div data-field-path="b7d4766d-770d-4886-823a-9468b41aef5b" data-field-entry-id="088fd504-0416-4c16-bdd6-6afbab0d83d4_b7d4766d-770d-4886-823a-9468b41aef5b">
        <fieldset class="_container_wz442_28 _fieldEntry_1e3gg_28">
          <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42 ashby-application-form-question-title" for="b7d4766d-770d-4886-823a-9468b41aef5b">How did you learn about this opportunity with Atlan?</label>
          <div class="_inputContainer_d7ago_28">
            <input class="_input_d7ago_28 ashby-application-form-input-autocomplete" placeholder="Start typing..." aria-autocomplete="list" aria-expanded="false" aria-haspopup="listbox" role="combobox" value="">
            <button type="button" class="_toggleButton_d7ago_32"></button>
          </div>
        </fieldset>
      </div>
      <div id="popup"></div>
      <button type="submit">Submit Application</button>
    </form>
    <script>
      const input = document.querySelector('input.ashby-application-form-input-autocomplete')
      const popup = document.getElementById('popup')
      const sources = ['LinkedIn', 'Indeed', 'Other']
      const render = () => {
        popup.innerHTML = ''
        const query = input.value.trim().toLowerCase()
        if (!query) return
        for (const source of sources) {
          if (!source.toLowerCase().includes(query) && query !== 'job board') continue
          const option = document.createElement('div')
          option.setAttribute('role', 'option')
          option.className = '_result_d7ago_107 ashby-application-form-input-autocomplete-popup-result'
          option.textContent = source
          option.addEventListener('mousedown', (event) => {
            event.preventDefault()
            input.value = source
            popup.innerHTML = ''
          })
          popup.appendChild(option)
        }
      }
      input.addEventListener('input', render)
      document.querySelector('button._toggleButton_d7ago_32').addEventListener('click', () => {
        input.value = input.value || 'L'
        render()
      })
    </script>`)
    try {
      const fields = await readFields(page, 'form')
      const referral = fields.find((field) => /learn about this opportunity/i.test(field.label))
      assert.ok(referral, fields.map((field) => field.label).join(' | '))
      assert.equal(referral!.type, 'combobox')
      assert.equal(referral!.required, true)
      assert.equal((await formReady(page, 'https://jobs.ashbyhq.com/fixture/application')).ok, false)
      assert.equal(await setValue(page, referral!, 'Job board'), true)
      assert.equal(await page.locator('input.ashby-application-form-input-autocomplete').inputValue(), 'LinkedIn')
      assert.equal(await fieldLooksEmpty(page, referral!), false)
      assert.equal((await formReady(page, 'https://jobs.ashbyhq.com/fixture/application')).ok, true)
    } finally { await page.close() }
  })

  it('commits any visible source option when the list has no Job board or LinkedIn', async () => {
    const page = await gotoHtml(`<form>
      <div class="ashby-application-form-field-entry">
        <label>How did you learn about this opportunity with Atlan?</label>
        <div>
          <input class="ashby-application-form-input-autocomplete" role="combobox" placeholder="Start typing...">
          <button type="button" id="toggle"></button>
        </div>
      </div>
      <div id="popup"></div>
      <button type="submit">Submit Application</button>
    </form>
    <script>
      const input = document.querySelector('input.ashby-application-form-input-autocomplete')
      const popup = document.getElementById('popup')
      const sources = ['Career fair', 'University']
      const renderAll = () => {
        popup.innerHTML = ''
        for (const source of sources) {
          const option = document.createElement('div')
          option.setAttribute('role', 'option')
          option.className = 'ashby-application-form-input-autocomplete-popup-result'
          option.textContent = source
          option.addEventListener('mousedown', (event) => {
            event.preventDefault()
            input.value = source
            popup.innerHTML = ''
          })
          popup.appendChild(option)
        }
      }
      input.addEventListener('input', () => { popup.innerHTML = '' })
      document.getElementById('toggle').addEventListener('click', renderAll)
    </script>`)
    try {
      const ok = await setValue(page, { label: 'How did you learn about this opportunity with Atlan?', type: 'combobox', required: true }, 'Job board')
      assert.equal(ok, true)
      assert.equal(await page.locator('input.ashby-application-form-input-autocomplete').inputValue(), 'Career fair')
    } finally { await page.close() }
  })
})
