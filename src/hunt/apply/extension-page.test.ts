import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'
import { clickListedDropdownOption, emptyRequiredFields, fillPageField, harvestFieldOptions, inventoryFields, typeAndListDropdownOptions } from './extension-page.js'

const chromePath = process.env.TEST_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser: Browser | null = await chromium.launch({ headless: true, executablePath: chromePath }).catch(() => null)

async function gotoHtml(html: string): Promise<Page> {
  const page = await browser!.newPage()
  await page.setContent(html, { waitUntil: 'domcontentloaded' })
  return page
}

describe('Huntly apply page script', { skip: !browser }, () => {
  after(async () => { await browser?.close() })

  it('inventories hashed Ashby how-did-you-learn and fills by clicking an option', async () => {
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
      const fields = await inventoryFields(page, 'form')
      const referral = fields.find((field) => /learn about this opportunity/i.test(field.label))
      assert.ok(referral, fields.map((field) => field.label).join(' | '))
      assert.equal(referral!.type, 'combobox')
      assert.equal(referral!.required, true)
      assert.equal((await emptyRequiredFields(page)).some((field) => /learn about this opportunity/i.test(field.label)), true)
      assert.equal(await fillPageField(page, referral!, 'LinkedIn'), true)
      assert.equal(await page.locator('input.ashby-application-form-input-autocomplete').inputValue(), 'LinkedIn')
      assert.equal((await emptyRequiredFields(page)).length, 0)
    } finally { await page.close() }
  })

  it('clicks Ashby Yes/No in-page without Playwright locators', async () => {
    const page = await gotoHtml(`<form>
      <div class="ashby-application-form-field-entry">
        <label>Are you legally authorized to work in the United States?*</label>
        <div class="ashby-application-form-input-yesno">
          <button type="button" aria-pressed="false">Yes</button>
          <button type="button" aria-pressed="false">No</button>
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
      const ok = await fillPageField(page, {
        label: 'Are you legally authorized to work in the United States?*',
        type: 'checkbox',
        required: true,
        options: ['Yes', 'No'],
      }, 'No')
      assert.equal(ok, true)
      assert.equal(await page.locator('.ashby-application-form-input-yesno > button', { hasText: 'No' }).getAttribute('aria-pressed'), 'true')
    } finally { await page.close() }
  })

  it('labels Lever sponsorship radios with the question, not Yes', async () => {
    const page = await gotoHtml(`<form>
      <ul>
        <li class="application-question">
          <div class="text"><div class="application-label">Do you now, or in the future require sponsorship?</div></div>
          <div class="application-field">
            <label><input type="radio" name="cards[xyz][field0]" value="Yes"> Yes</label>
            <label><input type="radio" name="cards[xyz][field0]" value="No"> No</label>
          </div>
        </li>
      </ul>
      <button type="submit">Submit application</button>
    </form>`)
    try {
      const fields = await inventoryFields(page, 'form')
      const sponsor = fields.find((field) => /sponsorship/i.test(field.label))
      assert.ok(sponsor, fields.map((field) => field.label).join(' | '))
      assert.equal(/^(yes)$/i.test(sponsor!.label), false)
      assert.equal(await fillPageField(page, sponsor!, 'Yes'), true)
      assert.equal(await page.locator('input[name="cards[xyz][field0]"][value="Yes"]').isChecked(), true)
    } finally { await page.close() }
  })

  it('clicks Yes on the matching Lever radio group, not the first Yes on the page', async () => {
    const page = await gotoHtml(`<form>
      <ul>
        <li class="application-question">
          <div class="application-label">Do you now, or in the future require sponsorship?</div>
          <label><input type="radio" name="spon" value="Yes"> Yes</label>
          <label><input type="radio" name="spon" value="No"> No</label>
        </li>
        <li class="application-question">
          <div class="application-label">Do you have the unrestricted right to work in the United States?</div>
          <label><input type="radio" name="auth" value="Yes"> Yes</label>
          <label><input type="radio" name="auth" value="No"> No</label>
        </li>
      </ul>
    </form>`)
    try {
      const fields = await inventoryFields(page, 'form')
      const sponsor = fields.find((field) => /sponsorship/i.test(field.label))!
      const auth = fields.find((field) => /unrestricted right to work/i.test(field.label))!
      assert.equal(await fillPageField(page, sponsor, 'Yes'), true)
      assert.equal(await fillPageField(page, auth, 'Yes'), true)
      assert.equal(await page.locator('input[name="spon"][value="Yes"]').isChecked(), true)
      assert.equal(await page.locator('input[name="auth"][value="Yes"]').isChecked(), true)
    } finally { await page.close() }
  })

  it('commits a location typeahead by clicking the matching option', async () => {
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
      const ok = await fillPageField(page, { label: 'Location*', type: 'combobox', required: true }, 'Bengaluru', {
        city: 'Bengaluru',
        region: 'Karnataka',
        country: 'India',
      })
      assert.equal(ok, true)
      assert.equal(await page.locator('#loc').inputValue(), 'Bengaluru, Karnataka, India')
      assert.equal(await page.locator('#loc').getAttribute('aria-invalid'), 'false')
    } finally { await page.close() }
  })

  it('clicks the Greenhouse city option after typing, not leaving the typed stub', async () => {
    const page = await gotoHtml(`<form id="application-form">
      <div class="field-wrapper">
        <label>Location (City)*</label>
        <div class="select">
          <div class="select-shell">
            <div class="select__control">
              <div class="select__value-container">
                <div class="select__placeholder">Select...</div>
                <div class="select__single-value" style="display:none"></div>
                <input class="select__input" role="combobox" aria-autocomplete="list" aria-required="true" value="">
              </div>
            </div>
          </div>
          <input required tabindex="-1" aria-hidden="true" class="requiredInput" value="">
        </div>
      </div>
      <div id="menu"></div>
    </form>
    <script>
      const input = document.querySelector('input[role="combobox"]')
      const shown = document.querySelector('.select__single-value')
      const placeholder = document.querySelector('.select__placeholder')
      const hidden = document.querySelector('input.requiredInput')
      const menu = document.getElementById('menu')
      const cities = ['Bangalore, Karnataka, India', 'Bangkok, Thailand']
      const render = (query) => {
        menu.innerHTML = ''
        const list = document.createElement('div')
        list.className = 'select__menu'
        list.style.height = '80px'
        const needle = (query || '').trim().toLowerCase()
        for (const city of cities) {
          if (needle && !city.toLowerCase().includes(needle)) continue
          const row = document.createElement('div')
          row.className = 'select__option'
          row.setAttribute('role', 'option')
          row.textContent = city
          row.addEventListener('mousedown', (event) => {
            if (!event.isTrusted) return
            event.preventDefault()
            shown.textContent = city
            shown.style.display = 'block'
            placeholder.style.display = 'none'
            hidden.value = 'bangalore-id'
            input.value = ''
            menu.innerHTML = ''
          })
          list.appendChild(row)
        }
        menu.appendChild(list)
      }
      input.addEventListener('input', () => render(input.value))
      input.addEventListener('mousedown', () => render(input.value))
      document.querySelector('.select__control').addEventListener('mousedown', () => render(input.value))
    </script>`)
    try {
      const fields = await inventoryFields(page, 'form')
      const city = fields.find((field) => /location \(city\)/i.test(field.label))
      assert.ok(city, fields.map((field) => field.label).join(' | '))
      assert.equal(await fillPageField(page, city!, 'Bangalore'), true)
      assert.equal(await page.locator('.select__single-value').innerText(), 'Bangalore, Karnataka, India')
      assert.equal(await page.locator('input.requiredInput').inputValue(), 'bangalore-id')
      const listed = await typeAndListDropdownOptions(page, city!.fid!, 'Ban')
      assert.ok(listed.some((option) => /bangalore/i.test(option)), listed.join('|'))
      assert.equal(await clickListedDropdownOption(page, 'Bangalore, Karnataka, India'), true)
    } finally { await page.close() }
  })

  it('waits for the typeahead to finish before listing dropdown options', async () => {
    const page = await gotoHtml(`<form id="application-form">
      <div class="field-wrapper">
        <label>Location (City)*</label>
        <input role="combobox" aria-autocomplete="list" value="">
      </div>
      <div id="menu"></div>
    </form>
    <script>
      const input = document.querySelector('input[role="combobox"]')
      const menu = document.getElementById('menu')
      let timer
      const render = (cities) => {
        menu.innerHTML = ''
        const list = document.createElement('div')
        list.className = 'select__menu'
        for (const city of cities) {
          const row = document.createElement('div')
          row.setAttribute('role', 'option')
          row.textContent = city
          list.appendChild(row)
        }
        menu.appendChild(list)
      }
      input.addEventListener('input', () => {
        render(['Bangkok, Thailand'])
        clearTimeout(timer)
        timer = setTimeout(() => render(['Bangalore, Karnataka, India', 'Bangkok, Thailand']), 1800)
      })
    </script>`)
    try {
      const fields = await inventoryFields(page, 'form')
      const city = fields.find((field) => /location \(city\)/i.test(field.label))
      assert.ok(city?.fid)
      const listed = await typeAndListDropdownOptions(page, city!.fid!, 'Ban')
      assert.ok(listed.some((option) => /bangalore/i.test(option)), listed.join('|'))
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
      assert.equal(await fillPageField(page, { label: 'Country', type: 'select-one', required: true }, 'India'), true)
      assert.equal(await page.locator('select').inputValue(), 'IN')
    } finally { await page.close() }
  })

  it('writes duplicate Name labels by fid, not first match', async () => {
    const page = await gotoHtml(`<form>
      <div class="ashby-application-form-field-entry"><label>Name</label><input id="first"></div>
      <div class="ashby-application-form-field-entry"><label>Name</label><input id="last"></div>
    </form>`)
    try {
      const fields = await inventoryFields(page, 'form')
      assert.equal(fields.length, 2)
      assert.ok(fields[0]!.fid)
      assert.ok(fields[1]!.fid)
      assert.notEqual(fields[0]!.fid, fields[1]!.fid)
      assert.equal(await fillPageField(page, fields[0]!, 'Ayan'), true)
      assert.equal(await fillPageField(page, fields[1]!, 'Mansoori'), true)
      assert.equal(await page.locator('#first').inputValue(), 'Ayan')
      assert.equal(await page.locator('#last').inputValue(), 'Mansoori')
    } finally { await page.close() }
  })

  it('inventories Greenhouse field-wrapper comboboxes and commits react-select by visible value', async () => {
    const page = await gotoHtml(`<form id="application-form">
      <div class="field-wrapper">
        <label id="country-label" for="country">Country*</label>
        <div class="select">
          <div class="select-shell">
            <div class="select__value-container">
              <div class="select__placeholder">Select...</div>
              <div class="select__single-value" style="display:none"></div>
              <input id="country" role="combobox" aria-autocomplete="list" value="">
            </div>
          </div>
        </div>
      </div>
      <div id="menu"></div>
      <button type="submit">Submit application</button>
    </form>
    <script>
      const input = document.querySelector('input[role="combobox"]')
      const shown = document.querySelector('.select__single-value')
      const placeholder = document.querySelector('.select__placeholder')
      const menu = document.getElementById('menu')
      const options = ['India', 'United States', 'Canada']
      input.addEventListener('input', () => {
        menu.innerHTML = ''
        const query = input.value.trim().toLowerCase()
        if (!query) return
        for (const option of options) {
          if (!option.toLowerCase().includes(query)) continue
          const row = document.createElement('div')
          row.setAttribute('role', 'option')
          row.textContent = option
          row.addEventListener('mousedown', (event) => {
            event.preventDefault()
            shown.textContent = option
            shown.style.display = 'block'
            placeholder.style.display = 'none'
            input.value = ''
            menu.innerHTML = ''
          })
          menu.appendChild(row)
        }
      })
    </script>`)
    try {
      const fields = await inventoryFields(page, 'form')
      const country = fields.find((field) => /country/i.test(field.label))
      assert.ok(country)
      assert.equal(country!.type, 'combobox')
      assert.equal(await fillPageField(page, country!, 'India', { country: 'India' }), true)
      assert.equal(await page.locator('.select__single-value').innerText(), 'India')
      assert.equal((await emptyRequiredFields(page)).length, 0)
    } finally { await page.close() }
  })

  it('treats Greenhouse EEO multi-select chips as filled and maps Male to Man', async () => {
    const page = await gotoHtml(`<form id="application-form">
      <div class="field-wrapper">
        <label>What gender identity do you most closely identify with?*</label>
        <div class="select">
          <div class="select__control">
            <div class="select__value-container select__value-container--is-multi">
              <input role="combobox" aria-autocomplete="list" value="" required>
            </div>
          </div>
        </div>
      </div>
      <div id="menu"></div>
      <button type="submit">Submit application</button>
    </form>
    <script>
      const input = document.querySelector('input[role="combobox"]')
      const container = document.querySelector('.select__value-container')
      const menu = document.getElementById('menu')
      const options = ['Man', 'Woman', 'Non-binary', 'I don\\'t wish to answer']
      const open = () => {
        menu.innerHTML = ''
        setTimeout(() => {
        for (const option of options) {
          const row = document.createElement('div')
          row.className = 'select__option'
          row.setAttribute('role', 'option')
          row.textContent = option
          row.addEventListener('mousedown', (event) => {
            event.preventDefault()
            const chip = document.createElement('div')
            chip.className = 'select__multi-value'
            const label = document.createElement('div')
            label.className = 'select__multi-value__label'
            label.textContent = option
            chip.appendChild(label)
            container.insertBefore(chip, input)
            input.value = ''
            menu.innerHTML = ''
          })
          menu.appendChild(row)
        }
        }, 200)
      }
      let openCount = 0
      const toggleMenu = () => {
        openCount += 1
        if (openCount % 2 === 1) open()
        else menu.innerHTML = ''
      }
      input.addEventListener('mousedown', toggleMenu)
      input.addEventListener('focus', toggleMenu)
      document.querySelector('.select__control').addEventListener('mousedown', toggleMenu)
      document.querySelector('.select__control').insertAdjacentHTML('beforeend', '<button type="button" aria-label="Toggle flyout"></button>')
      document.querySelector('button[aria-label="Toggle flyout"]').addEventListener('mousedown', (event) => {
        event.preventDefault()
        toggleMenu()
      })
    </script>`)
    try {
      const fields = await inventoryFields(page, 'form')
      const gender = fields.find((field) => /gender identity/i.test(field.label))
      assert.ok(gender, fields.map((field) => field.label).join(' | '))
      assert.equal(gender!.required, true)
      assert.equal((await emptyRequiredFields(page)).some((field) => /gender identity/i.test(field.label)), true)
      assert.equal(await fillPageField(page, gender!, 'Male'), true)
      assert.equal(await page.locator('.select__multi-value__label').innerText(), 'Man')
      assert.equal((await emptyRequiredFields(page)).length, 0)
    } finally { await page.close() }
  })

  it('maps Indian to Asian and never to American Indian or Native American', async () => {
    const page = await gotoHtml(`<form id="application-form">
      <div class="field-wrapper">
        <label>Please select up to 2 ethnicities that you most closely identify with?*</label>
        <div class="select">
          <div class="select__control">
            <div class="select__value-container select__value-container--is-multi">
              <input role="combobox" aria-autocomplete="list" value="" required>
            </div>
          </div>
        </div>
      </div>
      <div id="menu"></div>
    </form>
    <script>
      const input = document.querySelector('input[role="combobox"]')
      const container = document.querySelector('.select__value-container')
      const menu = document.getElementById('menu')
      const options = ['American Indian or Alaska Native', 'Native American', 'Asian', 'White']
      const open = () => {
        menu.innerHTML = ''
        const list = document.createElement('div')
        list.className = 'select__menu'
        list.style.height = '120px'
        for (const option of options) {
          const row = document.createElement('div')
          row.className = 'select__option'
          row.setAttribute('role', 'option')
          row.textContent = option
          row.addEventListener('mousedown', (event) => {
            event.preventDefault()
            const chip = document.createElement('div')
            chip.className = 'select__multi-value'
            const label = document.createElement('div')
            label.className = 'select__multi-value__label'
            label.textContent = option
            chip.appendChild(label)
            container.insertBefore(chip, input)
            input.value = ''
            menu.innerHTML = ''
          })
          list.appendChild(row)
        }
        menu.appendChild(list)
      }
      input.addEventListener('mousedown', open)
      document.querySelector('.select__control').addEventListener('mousedown', open)
    </script>`)
    try {
      const fields = await inventoryFields(page, 'form')
      const ethnicity = fields.find((field) => /ethnicit/i.test(field.label))
      assert.ok(ethnicity)
      assert.equal(await fillPageField(page, ethnicity!, 'Indian'), true)
      assert.equal(await page.locator('.select__multi-value__label').innerText(), 'Asian')
    } finally { await page.close() }
  })

  it('does not treat a filled Greenhouse phone as empty because aria-invalid is still true', async () => {
    const page = await gotoHtml(`<form id="application-form">
      <div class="field-wrapper">
        <label>Phone*</label>
        <input type="tel" required aria-invalid="true" value="9876543210">
      </div>
    </form>`)
    try {
      assert.equal((await emptyRequiredFields(page)).length, 0)
    } finally { await page.close() }
  })

  it('writes a national phone number after the country is known', async () => {
    const page = await gotoHtml(`<form id="application-form">
      <div class="field-wrapper">
        <label>Phone*</label>
        <input type="tel" required>
      </div>
    </form>`)
    try {
      assert.equal(await fillPageField(page, { label: 'Phone*', type: 'tel', required: true }, '+91 90000 00000', { country: 'India' }), true)
      assert.equal(await page.locator('input[type="tel"]').inputValue(), '9000000000')
    } finally { await page.close() }
  })

  it('selects Greenhouse EEO decline-to-answer from harvested options', async () => {
    const page = await gotoHtml(`<form id="application-form">
      <div class="field-wrapper">
        <label for="gender">Gender*</label>
        <div class="select">
          <div class="select-shell">
            <div class="select__value-container">
              <div class="select__placeholder">Select...</div>
              <div class="select__single-value" style="display:none"></div>
              <input id="gender" role="combobox" aria-autocomplete="list" value="">
              <button type="button" aria-label="Toggle flyout"></button>
            </div>
          </div>
        </div>
      </div>
      <div id="menu"></div>
    </form>
    <script>
      const input = document.querySelector('input[role="combobox"]')
      const shown = document.querySelector('.select__single-value')
      const placeholder = document.querySelector('.select__placeholder')
      const menu = document.getElementById('menu')
      const options = ['Male', 'Female', "I don't wish to answer"]
      const render = (query) => {
        menu.innerHTML = ''
        const needle = (query || '').trim().toLowerCase()
        for (const option of options) {
          if (needle && !option.toLowerCase().includes(needle)) continue
          const row = document.createElement('div')
          row.setAttribute('role', 'option')
          row.textContent = option
          row.addEventListener('mousedown', (event) => {
            event.preventDefault()
            shown.textContent = option
            shown.style.display = 'block'
            placeholder.style.display = 'none'
            input.value = ''
            menu.innerHTML = ''
          })
          menu.appendChild(row)
        }
      }
      input.addEventListener('input', () => render(input.value))
      document.querySelector('button[aria-label="Toggle flyout"]').addEventListener('click', () => render(''))
    </script>`)
    try {
      const fields = await inventoryFields(page, 'form')
      const gender = fields.find((field) => /gender/i.test(field.label))
      assert.ok(gender)
      const harvested = await harvestFieldOptions(page, gender!)
      assert.ok(harvested.includes("I don't wish to answer"), harvested.join('|'))
      assert.equal(await fillPageField(page, { ...gender!, options: harvested }, "I don't wish to answer"), true)
      assert.equal(await page.locator('.select__single-value').innerText(), "I don't wish to answer")
      assert.equal((await emptyRequiredFields(page)).length, 0)
    } finally { await page.close() }
  })

  it('treats a Greenhouse react-select as empty when the hidden required input is empty even if a chip is showing', async () => {
    const page = await gotoHtml(`<form id="application-form">
      <div class="field-wrapper">
        <label class="label select__label">By selecting "I agree," I understand that the information I have provided as part of this job application will be processed in accordance with Reddit's Candidate Privacy Policy. *</label>
        <div class="select">
          <div class="select-shell">
            <div class="select__control">
              <div class="select__value-container">
                <div class="select__single-value">I agree</div>
                <input class="select__input" role="combobox" aria-autocomplete="list" aria-required="true" value="">
              </div>
            </div>
          </div>
          <input required tabindex="-1" aria-hidden="true" value="">
        </div>
      </div>
    </form>`)
    try {
      const empty = await emptyRequiredFields(page)
      assert.equal(empty.some((field) => /i agree/i.test(field.label)), true, empty.map((field) => field.label).join(' | '))
    } finally { await page.close() }
  })

  it('does not treat the I-agree question label as a committed Greenhouse choice', async () => {
    const page = await gotoHtml(`<form id="application-form">
      <div class="field-wrapper">
        <label class="label select__label" id="question_68958890-label">By selecting "I agree," I understand that the information I have provided as part of this job application will be processed in accordance with Reddit's Candidate Privacy Policy. *</label>
        <div class="select">
          <div class="select-shell">
            <div class="select__control">
              <div class="select__value-container">
                <div class="select__placeholder">Select...</div>
                <input id="question_68958890" class="select__input" role="combobox" aria-autocomplete="list" aria-required="true" aria-labelledby="question_68958890-label" value="">
              </div>
            </div>
          </div>
          <input required tabindex="-1" aria-hidden="true" class="remix-css-1a0ro4n-requiredInput" value="">
        </div>
      </div>
    </form>`)
    try {
      const empty = await emptyRequiredFields(page)
      assert.equal(empty.some((field) => /i agree/i.test(field.label)), true, empty.map((field) => field.label).join(' | '))
    } finally { await page.close() }
  })

  it('does not treat Greenhouse react-select filter text as a committed answer', async () => {
    const page = await gotoHtml(`<form id="application-form">
      <div class="field-wrapper">
        <label id="question_68958890-label">By selecting "I agree," I understand that the information I have provided as part of this job application will be processed in accordance with Reddit's Candidate Privacy Policy. *</label>
        <div class="select">
          <div class="select-shell">
            <div class="select__control">
              <div class="select__value-container">
                <div class="select__placeholder">Select...</div>
                <div class="select__input-container">
                  <input id="question_68958890" class="select__input" role="combobox" aria-autocomplete="list" aria-required="true" aria-labelledby="question_68958890-label" value="I agree">
                </div>
              </div>
            </div>
          </div>
          <input required tabindex="-1" aria-hidden="true" class="remix-css-1a0ro4n-requiredInput" value="">
        </div>
      </div>
    </form>`)
    try {
      const empty = await emptyRequiredFields(page)
      assert.equal(empty.some((field) => /i agree/i.test(field.label)), true, empty.map((field) => field.label).join(' | '))
    } finally { await page.close() }
  })

  it('commits Greenhouse I-agree with a trusted option click, not typed filter text', async () => {
    const page = await gotoHtml(`<form id="application-form">
      <div class="field-wrapper">
        <label id="agree-label">By selecting "I agree," I understand that the information I have provided as part of this job application will be processed in accordance with Reddit's Candidate Privacy Policy. *</label>
        <div class="select">
          <div class="select-shell">
            <div class="select__control">
              <div class="select__value-container">
                <div class="select__placeholder">Select...</div>
                <div class="select__single-value" style="display:none"></div>
                <div class="select__input-container">
                  <input id="agree" class="select__input" role="combobox" aria-autocomplete="list" aria-required="true" aria-labelledby="agree-label" value="">
                </div>
              </div>
              <button type="button" aria-label="Toggle flyout"></button>
            </div>
          </div>
          <input required tabindex="-1" aria-hidden="true" class="requiredInput" value="">
        </div>
      </div>
      <div id="menu"></div>
    </form>
    <script>
      const input = document.querySelector('input[role="combobox"]')
      const shown = document.querySelector('.select__single-value')
      const placeholder = document.querySelector('.select__placeholder')
      const hidden = document.querySelector('input.requiredInput')
      const menu = document.getElementById('menu')
      const open = () => {
        menu.innerHTML = ''
        const list = document.createElement('div')
        list.className = 'select__menu'
        list.style.height = '48px'
        const row = document.createElement('div')
        row.className = 'select__option'
        row.setAttribute('role', 'option')
        row.textContent = 'I agree'
        row.addEventListener('mousedown', (event) => {
          if (!event.isTrusted) return
          event.preventDefault()
          shown.textContent = 'I agree'
          shown.style.display = 'block'
          placeholder.style.display = 'none'
          hidden.value = '750098100'
          input.value = ''
          menu.innerHTML = ''
        })
        list.appendChild(row)
        menu.appendChild(list)
      }
      input.addEventListener('mousedown', open)
      document.querySelector('.select__control').addEventListener('mousedown', open)
      document.querySelector('button[aria-label="Toggle flyout"]').addEventListener('click', open)
    </script>`)
    try {
      const fields = await inventoryFields(page, 'form')
      const agree = fields.find((field) => /i agree/i.test(field.label))
      assert.ok(agree, fields.map((field) => field.label).join(' | '))
      assert.equal((await emptyRequiredFields(page)).some((field) => /i agree/i.test(field.label)), true)
      assert.equal(await fillPageField(page, agree!, 'I agree'), true)
      assert.equal(await page.locator('.select__single-value').innerText(), 'I agree')
      assert.equal(await page.locator('input.requiredInput').inputValue(), '750098100')
      assert.equal((await emptyRequiredFields(page)).length, 0)
    } finally { await page.close() }
  })

  it('opens the Greenhouse menu even when a hidden phone country list is already in the DOM', async () => {
    const page = await gotoHtml(`<form id="application-form">
      <ul role="listbox" class="iti__country-list" style="height:0;overflow:hidden">
        <li role="option" class="iti__country">United States +1</li>
        <li role="option" class="iti__country">India +91</li>
      </ul>
      <div class="field-wrapper">
        <label id="agree-label">By selecting "I agree," I understand that the information I have provided as part of this job application will be processed in accordance with Reddit's Candidate Privacy Policy. *</label>
        <div class="select">
          <div class="select-shell">
            <div class="select__control">
              <div class="select__value-container">
                <div class="select__placeholder">Select...</div>
                <div class="select__single-value" style="display:none"></div>
                <input id="agree" class="select__input" role="combobox" aria-autocomplete="list" aria-required="true" aria-labelledby="agree-label" value="">
              </div>
            </div>
          </div>
        </div>
      </div>
      <div id="menu"></div>
    </form>
    <script>
      const input = document.querySelector('input[role="combobox"]')
      const shown = document.querySelector('.select__single-value')
      const placeholder = document.querySelector('.select__placeholder')
      const menu = document.getElementById('menu')
      const open = () => {
        if (menu.querySelector('.select__menu')) return
        const list = document.createElement('div')
        list.className = 'select__menu'
        list.style.height = '48px'
        const row = document.createElement('div')
        row.className = 'select__option'
        row.setAttribute('role', 'option')
        row.textContent = 'I agree'
        row.addEventListener('mousedown', (event) => {
          if (!event.isTrusted) return
          shown.textContent = 'I agree'
          shown.style.display = 'block'
          placeholder.style.display = 'none'
          input.value = ''
          menu.innerHTML = ''
        })
        list.appendChild(row)
        menu.appendChild(list)
      }
      input.addEventListener('mousedown', open)
      document.querySelector('.select__control').addEventListener('mousedown', open)
    </script>`)
    try {
      const fields = await inventoryFields(page, 'form')
      const agree = fields.find((field) => /i agree/i.test(field.label))
      assert.ok(agree, fields.map((field) => field.label).join(' | '))
      assert.equal(await fillPageField(page, agree!, 'I agree'), true)
      assert.equal(await page.locator('.select__single-value').innerText(), 'I agree')
    } finally { await page.close() }
  })
})
