import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { schemaFingerprint } from '../schema/fingerprint.js'
import type { FormSchema, SchemaField } from '../schema/types.js'

/**
 * Local replicas of the two ATS families that carry 92% of production volume.
 * The markup follows the hosted forms closely enough to exercise the real page
 * script: react-select style dropdowns with hidden required inputs, Ashby
 * yes/no buttons, conditional questions, custom JavaScript validation, and a
 * job description that says "thank you" before anything is submitted.
 * Fixture only: nothing here talks to an employer.
 */

const REACT_SELECT = (id: string, label: string, options: string[]) => `
<div class="field-wrapper">
  <label id="${id}-label" for="${id}">${label}<span class="required">*</span></label>
  <div class="select" data-options='${JSON.stringify(options)}'>
    <div class="select__control">
      <div class="select__value-container"><div class="select__placeholder">Select...</div><input id="${id}" role="combobox" aria-required="true" class="select__input" autocomplete="off"></div>
      <button type="button" aria-label="Toggle flyout" class="select__dropdown-indicator">▾</button>
    </div>
    <input class="select__requiredInput" tabindex="-1" aria-hidden="true" required value="" style="opacity:0;height:1px;width:1px;position:absolute" name="${id}">
  </div>
</div>`

export const GREENHOUSE_HTML = `<!doctype html><html><body>
<h1>Senior Backend Engineer</h1>
<div class="job__description"><p>Acme builds payments infrastructure.</p><p>Thank you for your interest in Acme!</p></div>
<form id="application-form" novalidate>
  <div class="field-wrapper"><label for="first_name">First Name<span class="required">*</span></label><input id="first_name" name="first_name" aria-required="true" type="text"></div>
  <div class="field-wrapper"><label for="last_name">Last Name<span class="required">*</span></label><input id="last_name" name="last_name" aria-required="true" type="text"></div>
  <div class="field-wrapper"><label for="email">Email<span class="required">*</span></label><input id="email" name="email" aria-required="true" type="text"></div>
  <div class="field-wrapper"><label for="phone">Phone</label><input id="phone" name="phone" type="tel"></div>
  <div class="field-wrapper"><label for="resume">Resume/CV<span class="required">*</span></label><div class="file-upload"><button type="button" onclick="document.getElementById('resume').click()">Attach</button><input type="file" id="resume" name="resume" style="display:none"><span id="resume-name"></span></div></div>
  ${REACT_SELECT('question_111', 'Will you now or in the future require sponsorship for a visa to remain in your current location?', ['No', 'Yes, EU Blue Card', 'Yes, but not one of the visas listed here'])}
  ${REACT_SELECT('question_222', 'What is your current country of residence?', ['Germany', 'India', 'United States'])}
  <div class="field-wrapper"><fieldset><legend>Are you open to relocation?<span class="required">*</span></legend>
    <label><input type="radio" name="question_333" value="Yes">Yes</label><label><input type="radio" name="question_333" value="No">No</label></fieldset></div>
  <div class="field-wrapper" id="relocation-city" style="display:none"><label for="relocation_city">Which city would you relocate to?<span class="required">*</span></label><input id="relocation_city" type="text"></div>
  <div class="field-wrapper"><label for="question_444">Why Acme?<span class="required">*</span></label><textarea id="question_444" name="question_444" aria-required="true"></textarea></div>
  <div class="field-wrapper"><label for="gender">Gender</label><select id="gender" name="gender"><option value="">Select...</option><option>Male</option><option>Female</option><option>Decline To Self Identify</option></select></div>
  <div class="field-wrapper"><label><input type="checkbox" id="question_555" name="question_555" aria-required="true"> I acknowledge the AI policy for this application<span class="required">*</span></label></div>
  <div id="errors"></div>
  <button type="submit" id="submit_app">Submit application</button>
</form>
<script>
for (const shell of document.querySelectorAll('.select')) {
  const options = JSON.parse(shell.dataset.options)
  const input = shell.querySelector('input[role=combobox]')
  const hidden = shell.querySelector('.select__requiredInput')
  const container = shell.querySelector('.select__value-container')
  const open = () => {
    close()
    const menu = document.createElement('div'); menu.className = 'select__menu'
    const list = document.createElement('div'); list.className = 'select__menu-list'; menu.appendChild(list)
    const query = input.value.trim().toLowerCase()
    for (const option of options.filter(o => !query || o.toLowerCase().includes(query))) {
      const node = document.createElement('div'); node.className = 'select__option'; node.setAttribute('role', 'option'); node.textContent = option
      node.addEventListener('mousedown', (event) => { event.preventDefault(); choose(option) })
      node.addEventListener('click', () => choose(option))
      list.appendChild(node)
    }
    shell.appendChild(menu)
  }
  const close = () => shell.querySelector('.select__menu')?.remove()
  const choose = (option) => {
    hidden.value = option; input.value = ''
    container.querySelector('.select__placeholder')?.remove()
    let single = container.querySelector('.select__single-value')
    if (!single) { single = document.createElement('div'); single.className = 'select__single-value'; container.prepend(single) }
    single.textContent = option
    close()
  }
  shell.querySelector('.select__control').addEventListener('click', open)
  input.addEventListener('input', open)
  input.addEventListener('keydown', (event) => { if (event.key === 'ArrowDown') open() })
}
document.getElementById('resume').addEventListener('change', (event) => { document.getElementById('resume-name').textContent = event.target.files[0]?.name || '' })
for (const radio of document.querySelectorAll('input[name=question_333]')) radio.addEventListener('change', () => {
  document.getElementById('relocation-city').style.display = document.querySelector('input[name=question_333]:checked')?.value === 'Yes' ? 'block' : 'none'
})
document.getElementById('application-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const missing = []
  for (const id of ['first_name', 'last_name', 'email', 'question_444']) if (!document.getElementById(id).value.trim()) missing.push(id)
  for (const hidden of document.querySelectorAll('.select__requiredInput')) if (!hidden.value) missing.push(hidden.name)
  if (!document.querySelector('input[name=question_333]:checked')) missing.push('question_333')
  if (document.getElementById('relocation-city').style.display !== 'none' && !document.getElementById('relocation_city').value.trim()) missing.push('relocation_city')
  if (!document.getElementById('question_555').checked) missing.push('question_555')
  if (!document.getElementById('resume').files.length) missing.push('resume')
  const errors = document.getElementById('errors')
  if (missing.length) {
    errors.innerHTML = '<div class="error" role="alert">This field is required.</div>'
    for (const id of missing) document.getElementById(id)?.setAttribute('aria-invalid', 'true')
    return
  }
  const body = {}
  for (const el of document.querySelectorAll('input:not([type=file]):not([type=radio]):not([type=checkbox]), textarea, select')) if (el.name) body[el.name] = el.value
  body.question_333 = document.querySelector('input[name=question_333]:checked').value
  body.relocation_city = document.getElementById('relocation_city').value
  body.question_555 = document.getElementById('question_555').checked
  body.resume = document.getElementById('resume').files[0].name
  const response = await fetch(location.pathname + '/applications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (response.ok) {
    history.pushState({}, '', location.pathname + '/confirmation')
    document.body.innerHTML = '<h1>Thank you for applying.</h1><p>Your application has been received.</p>'
  }
})
</script></body></html>`

export const ASHBY_HTML = `<!doctype html><html><body>
<h1>Software Engineer</h1>
<form class="ashby-application-form-container" onsubmit="return false">
  <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_x" for="_systemfield_name">Name</label><input id="_systemfield_name" name="_systemfield_name" type="text"></div>
  <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_x" for="_systemfield_email">Email</label><input id="_systemfield_email" name="_systemfield_email" type="email"></div>
  <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_x" for="_systemfield_resume">Resume</label><input id="_systemfield_resume" name="_systemfield_resume" type="file"></div>
  <div class="ashby-application-form-field-entry" data-field-path="sponsor"><label class="ashby-application-form-question-title _required_x">Will you require work sponsorship now and/or in the future?</label>
    <div class="ashby-application-form-input-yesno"><button type="button" aria-pressed="false">Yes</button><button type="button" aria-pressed="false">No</button></div></div>
  <div class="ashby-application-form-field-entry" data-field-path="office"><fieldset><legend class="ashby-application-form-question-title _required_x">Which office are you applying to? (Select both if appropriate)</legend>
    <label><input type="checkbox" name="office" value="SF">San Francisco HQ - 181 Fremont Street</label>
    <label><input type="checkbox" name="office" value="NYC">New York City - 1 World Trade</label></fieldset></div>
  <button type="submit" class="ashby-application-form-submit-button">Submit Application</button>
</form>
<script>
for (const group of document.querySelectorAll('.ashby-application-form-input-yesno')) for (const button of group.querySelectorAll('button')) button.addEventListener('click', () => {
  for (const other of group.querySelectorAll('button')) other.setAttribute('aria-pressed', other === button ? 'true' : 'false')
})
document.querySelector('.ashby-application-form-submit-button').addEventListener('click', async () => {
  const ok = document.getElementById('_systemfield_name').value && document.getElementById('_systemfield_email').value
    && document.getElementById('_systemfield_resume').files.length
    && document.querySelector('.ashby-application-form-input-yesno button[aria-pressed=true]')
    && document.querySelectorAll('input[name=office]:checked').length
  if (!ok) { document.querySelector('form').insertAdjacentHTML('beforeend', '<div role="alert" class="_error">Missing entry for required field</div>'); return }
  const response = await fetch('/api/non-user-graphql?op=ApiApplicationFormSubmit', { method: 'POST', body: JSON.stringify({ offices: [...document.querySelectorAll('input[name=office]:checked')].map(b => b.value), sponsor: document.querySelector('.ashby-application-form-input-yesno button[aria-pressed=true]').textContent }) })
  if (response.ok) document.querySelector('form').outerHTML = '<div><h2>Thanks for applying!</h2><p>Your application was successfully submitted.</p></div>'
})
</script></body></html>`

const field = (overrides: Partial<SchemaField> & Pick<SchemaField, 'key' | 'label' | 'kind'>): SchemaField => ({ required: true, options: [], section: 'question', ...overrides })

/** What Greenhouse's questions API would publish for GREENHOUSE_HTML. */
export function greenhouseFixtureSchema(url: string): FormSchema {
  const fields: SchemaField[] = [
    field({ key: 'gh:first_name', label: 'First Name', kind: 'text', atsName: 'first_name', section: 'profile' }),
    field({ key: 'gh:last_name', label: 'Last Name', kind: 'text', atsName: 'last_name', section: 'profile' }),
    field({ key: 'gh:email', label: 'Email', kind: 'email', atsName: 'email', section: 'profile' }),
    field({ key: 'gh:phone', label: 'Phone', kind: 'phone', atsName: 'phone', required: false, section: 'profile' }),
    field({ key: 'gh:resume', label: 'Resume/CV', kind: 'file', atsName: 'resume', fileRole: 'resume', section: 'profile' }),
    field({ key: 'gh:question_111', label: 'Will you now or in the future require sponsorship for a visa to remain in your current location?', kind: 'select', atsName: 'question_111', options: [{ label: 'No' }, { label: 'Yes, EU Blue Card' }, { label: 'Yes, but not one of the visas listed here' }] }),
    field({ key: 'gh:question_222', label: 'What is your current country of residence?', kind: 'select', atsName: 'question_222', options: [{ label: 'Germany' }, { label: 'India' }, { label: 'United States' }] }),
    field({ key: 'gh:question_333', label: 'Are you open to relocation?', kind: 'select', atsName: 'question_333', options: [{ label: 'Yes' }, { label: 'No' }] }),
    field({ key: 'gh:question_444', label: 'Why Acme?', kind: 'textarea', atsName: 'question_444' }),
    field({ key: 'gh:gender', label: 'Gender', kind: 'select', atsName: 'gender', required: false, section: 'eeo', options: [{ label: 'Male' }, { label: 'Female' }, { label: 'Decline To Self Identify' }] }),
    field({ key: 'gh:question_555', label: 'I acknowledge the AI policy for this application', kind: 'checkbox', atsName: 'question_555', section: 'consent' }),
  ]
  return { source: 'greenhouse', url, fields, fingerprint: schemaFingerprint(fields) }
}

export function ashbyFixtureSchema(url: string): FormSchema {
  const fields: SchemaField[] = [
    field({ key: 'ashby:_systemfield_name', label: 'Name', kind: 'text', atsName: '_systemfield_name', section: 'profile' }),
    field({ key: 'ashby:_systemfield_email', label: 'Email', kind: 'email', atsName: '_systemfield_email', section: 'profile' }),
    field({ key: 'ashby:_systemfield_resume', label: 'Resume', kind: 'file', atsName: '_systemfield_resume', fileRole: 'resume', section: 'profile' }),
    field({ key: 'ashby:sponsor', label: 'Will you require work sponsorship now and/or in the future?', kind: 'boolean', atsName: 'sponsor', options: [{ label: 'Yes' }, { label: 'No' }] }),
    field({ key: 'ashby:office', label: 'Which office are you applying to? (Select both if appropriate)', kind: 'multiselect', atsName: 'office', options: [{ label: 'San Francisco HQ - 181 Fremont Street' }, { label: 'New York City - 1 World Trade' }] }),
  ]
  return { source: 'ashby', url, fields, fingerprint: schemaFingerprint(fields) }
}

/** Serves both fixtures and records what each form submitted. */
export async function serveFormFixtures(): Promise<{ origin: string; submissions: Array<{ path: string; body: unknown }>; close(): Promise<void> }> {
  const submissions: Array<{ path: string; body: unknown }> = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    if (req.method === 'POST') {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        submissions.push({ path: url.pathname, body: (() => { try { return JSON.parse(raw) } catch { return raw } })() })
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      })
      return
    }
    const html = url.pathname.startsWith('/acme/jobs/') ? GREENHOUSE_HTML : url.pathname.startsWith('/ashby/') ? ASHBY_HTML : null
    if (!html) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    submissions,
    // Keep-alive sockets held by a still-open browser would block close() forever.
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
