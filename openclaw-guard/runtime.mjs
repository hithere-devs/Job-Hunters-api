import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveExtensionProfile } from './extension-profile.mjs'

/** Private runtime adapter deliberately pinned. Upgrading OpenClaw requires revalidation. */
let runtime
export async function loadRuntime(root) {
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (metadata.name !== 'openclaw' || metadata.version !== '2026.9.3') throw new Error('unsupported_openclaw_version')
  runtime ??= import(pathToFileURL(join(root, 'dist/pw-session-CQV8ZkDn.mjs')).href)
  const exports = await runtime
  if (typeof exports.C !== 'function' || typeof exports.l !== 'function' || typeof exports.L !== 'function') throw new Error('unsupported_ref_runtime')
  return {
    pageForTarget: exports.C, refLocator: exports.l, restoreRoleRefs: exports.L,
    extensionApi: async () => {
      const stateModule = await import(pathToFileURL(join(root, 'dist/browser-control-state-CLsCObQm.mjs')).href)
      const configModule = await import(pathToFileURL(join(root, 'dist/config-n_aIDo5k.mjs')).href)
      if (typeof stateModule.getBrowserControlState !== 'function' || typeof configModule.a !== 'function') throw new Error('unsupported_extension_runtime')
      return { getBrowserControlState: stateModule.getBrowserControlState, resolveProfile: configModule.a }
    },
  }
}

/** Optional extension route. No extension URL, token or supplied input is logged. */
export async function selectGuardBrowser({ runtime, policy, tenant, profileName = 'tenant', expectedPort, action }) {
  if (!Number.isInteger(tenant) || tenant < 1 || tenant > 10 || !['tenant', 'extension-test'].includes(profileName)) throw new Error('invalid_guard_browser_route')
  const rawCdpUrl = `http://127.0.0.1:${9200 + tenant}`
  const rawPage = await runtime.pageForTarget({ cdpUrl: rawCdpUrl, targetId: policy.targetId })
  if (profileName === 'tenant') return { rawPage, refPage: rawPage, cdpUrl: rawCdpUrl, profileName, bootstrap: false }
  if (!Number.isInteger(expectedPort) || expectedPort < 1024 || expectedPort > 65535) throw new Error('invalid_extension_port')
  const api = await runtime.extensionApi()
  let extension
  try {
    extension = resolveExtensionProfile({ state: api.getBrowserControlState(), resolveProfile: api.resolveProfile, profileName, expectedPort })
  } catch (error) {
    // Only a specifically unstarted relay may bootstrap with one read-only snapshot.
    // Wrong port/profile/auth is never a reason to use raw CDP for the action.
    if (action === 'snapshot' && error?.bootstrapAllowed === true) return { rawPage, refPage: null, cdpUrl: null, profileName, bootstrap: true }
    throw new Error('extension_runtime_not_ready')
  }
  const refPage = await runtime.pageForTarget({ cdpUrl: extension.cdpUrl, targetId: policy.targetId })
  const session = await refPage.context().newCDPSession(refPage)
  try {
    const result = await session.send('Target.getTargetInfo')
    if (result?.targetInfo?.targetId !== policy.targetId || result.targetInfo.type !== 'page') throw new Error('extension_target_mismatch')
  } finally { await session.detach() }
  const route = { rawPage, refPage, profileName, bootstrap: false }
  Object.defineProperty(route, 'cdpUrl', { value: extension.cdpUrl, enumerable: false })
  return route
}

/** Read labels/types only. In particular this never reads an input's value. */
export function describeElement(element) {
  const name = element.getAttribute('aria-label') || (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => element.ownerDocument.getElementById(id)?.textContent || '').join(' ').trim() || element.textContent?.trim().slice(0, 1000) || ''
  const group = element.closest('fieldset,[role="radiogroup"],[role="group"]')
  let groupName = group?.getAttribute('aria-label') || group?.querySelector('legend')?.textContent?.trim() || ''
  // Ashby implements one logical boolean as two plain buttons. Match only
  // its observed field-entry/yesno structure, never an arbitrary ancestor.
  let ashbyBoolean = false
  if (element.tagName === 'BUTTON' && /^(?:Yes|No)$/i.test(name.trim())) {
    const choices = element.closest('.ashby-application-form-input-yesno')
    const entry = choices?.closest('.ashby-application-form-field-entry')
    const buttons = Array.from(choices?.querySelectorAll('button') || [])
    const labels = Array.from(entry?.querySelectorAll('label') || []).filter(label => label.closest('.ashby-application-form-field-entry') === entry && !label.querySelector('input,select,textarea,button'))
    const optionNames = buttons.map(button => (button.textContent || '').trim().toLowerCase())
    const backingControls = Array.from(choices?.querySelectorAll('input,select,textarea,a') || [])
    const backingValid = backingControls.length === 0 || (backingControls.length === 1 && backingControls[0].tagName === 'INPUT' && backingControls[0].getAttribute('type') === 'checkbox' && backingControls[0].parentElement === choices)
    const label = labels.length === 1 ? labels[0].textContent?.trim() || '' : ''
    if (entry && choices && buttons.length === 2 && buttons.includes(element) && optionNames.includes('yes') && optionNames.includes('no') && entry.querySelectorAll('.ashby-application-form-input-yesno').length === 1 && backingValid && buttons.every(button => !button.hasAttribute('form') && !button.hasAttribute('formaction') && !['submit', 'reset'].includes(button.getAttribute('type'))) && label.length > 5 && label.length <= 600 && !/\b(?:submit|submission|finish|complete|send|confirm)\b/i.test(label)) {
      groupName = label
      ashbyBoolean = true
    }
  }
  const ashbyAutocompleteLabel = control => {
    if (control.tagName !== 'INPUT' || control.getAttribute('role') !== 'combobox' || !control.classList?.contains('ashby-application-form-input-autocomplete')) return ''
    const entry = control.closest('.ashby-application-form-field-entry')
    const labels = Array.from(entry?.querySelectorAll('label') || []).filter(label => label.closest('.ashby-application-form-field-entry') === entry && !label.querySelector('input,select,textarea,button'))
    return labels.length === 1 && entry.querySelectorAll('[role="combobox"]').length === 1 ? labels[0].textContent?.trim() || '' : ''
  }
  let autocompleteChoice = false
  if (element.getAttribute('role') === 'combobox') groupName = ashbyAutocompleteLabel(element) || groupName
  if (element.getAttribute('role') === 'option' && element.classList?.contains('ashby-application-form-input-autocomplete-popup-result')) {
    const listbox = element.closest('[role="listbox"]')
    if (listbox?.id && !element.querySelector('input,select,textarea,button,a')) {
      const controllers = Array.from(element.ownerDocument.querySelectorAll('[role="combobox"]')).filter(control => control.getAttribute('aria-expanded') === 'true' && (control.getAttribute('aria-controls') || '').split(/\s+/).includes(listbox.id))
      if (controllers.length === 1) {
        const control = controllers[0], question = ashbyAutocompleteLabel(control), box = control.getBoundingClientRect(), style = control.ownerDocument.defaultView.getComputedStyle(control)
        if (question && question.length <= 600 && box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !control.disabled && control.getAttribute('aria-disabled') !== 'true') {
          groupName = question
          autocompleteChoice = true
        }
      }
    }
  }
  const ownLabels = Array.from(element.labels || []).map(label => label.textContent?.trim() || '').join(' ')
  const label = groupName || ownLabels || element.getAttribute('aria-label') || element.getAttribute('placeholder') || name
  const role = element.getAttribute('role') || ''
  const choiceContext = Boolean(groupName || (element.getAttribute('type') === 'checkbox' && ownLabels && !/^(?:yes|no|agree|disagree|true|false)$/i.test(ownLabels.trim())))
  const box = element.getBoundingClientRect()
  const style = element.ownerDocument.defaultView.getComputedStyle(element)
  return {
    tag: element.tagName.toLowerCase(), type: ashbyBoolean ? 'checkbox' : element.getAttribute('type')?.toLowerCase() || (element.tagName === 'TEXTAREA' ? 'textarea' : element.tagName === 'SELECT' ? 'select' : ['radio', 'checkbox', 'option'].includes(role) ? role : 'text'),
    role, name: name || ownLabels, label, choiceContext,
    ...(autocompleteChoice ? { autocompleteChoice: true } : {}),
    ...(ashbyBoolean ? { choiceValue: String(name.trim().toLowerCase() === 'yes') } : {}),
    visible: box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
    disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
    checked: Boolean(element.checked) || element.getAttribute('aria-checked') === 'true',
  }
}
export function describePage() {
  // Read types and labels, never values. Hidden reCAPTCHA response inputs are
  // normal ATS plumbing, not an interactive human challenge.
  const visible = el => {
    const box = el.getBoundingClientRect()
    const style = document.defaultView.getComputedStyle(el)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[hidden],[aria-hidden="true"]')
  }
  const credentialPattern = /password|passcode|one.?time|\botp\b|verification.?code|security.?code|recovery.?code|api.?key|access.?token|refresh.?token|captcha|not.?a.?robot|human.?verification|verify.{0,20}human|(?:i am|i.m|you are|you.re).{0,10}human/i
  const fields = Array.from(document.querySelectorAll('input,textarea,[role="checkbox"]'))
  const hasSecret = fields.some(el => visible(el) && credentialPattern.test([el.getAttribute('type'), el.getAttribute('autocomplete'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('aria-label'), ...Array.from(el.labels || []).map(l => l.textContent), el.getAttribute('role') === 'checkbox' ? el.textContent : ''].join(' ')))
  // A header Sign in button is not a login form; its click remains denied.
  const loginRoute = /\/(?:login|signin|sign-in|auth)(?:\/|\?|$)/i.test(location.pathname)
  const steps = (document.body?.innerText || '').match(/\bstep\s*(\d+)\s*(?:of|\/)\s*(\d+)\b/i)
  const wizardStep = steps && Number(steps[1]) > 0 && Number(steps[2]) <= 30 ? { current: Number(steps[1]), total: Number(steps[2]) } : null
  return { hasAuthentication: hasSecret || loginRoute, wizardStep }
}

/** Invisible analytics/challenge iframes are not rendered in ARIA snapshots.
 * Inspect no content in those frames. Visible off-host frames still fail policy. */
export async function frameIsVisible(frame) {
  let current = frame
  while (current.parentFrame()) {
    const element = await current.frameElement()
    try {
      const visible = await element.evaluate(el => {
        const box = el.getBoundingClientRect(), style = el.ownerDocument.defaultView.getComputedStyle(el)
        return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.closest('[hidden],[aria-hidden="true"]')
      })
      if (!visible) return false
    } finally { await element.dispose() }
    current = current.parentFrame()
  }
  return true
}
export async function pageFacts(page, targetId) {
  const frames = []
  for (const frame of page.frames()) if (await frameIsVisible(frame)) frames.push(frame)
  const observed = await Promise.all(frames.map(frame => frame.evaluate(describePage)))
  return { targetId, url: page.url(), frameUrls: frames.map(frame => frame.url()), hasAuthentication: observed.some(frame => frame.hasAuthentication), wizardStep: observed[0]?.wizardStep ?? null }
}
