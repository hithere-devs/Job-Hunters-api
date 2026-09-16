import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Private runtime adapter deliberately pinned. Upgrading OpenClaw requires revalidation. */
let runtime
export async function loadRuntime(root) {
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (metadata.name !== 'openclaw' || metadata.version !== '2026.9.3') throw new Error('unsupported_openclaw_version')
  runtime ??= import(pathToFileURL(join(root, 'dist/pw-session-CQV8ZkDn.mjs')).href)
  const exports = await runtime
  if (typeof exports.C !== 'function' || typeof exports.l !== 'function' || typeof exports.L !== 'function') throw new Error('unsupported_ref_runtime')
  return { pageForTarget: exports.C, refLocator: exports.l, restoreRoleRefs: exports.L }
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
    const label = labels.length === 1 ? labels[0].textContent?.trim() || '' : ''
    if (entry && choices && buttons.length === 2 && buttons.includes(element) && optionNames.includes('yes') && optionNames.includes('no') && entry.querySelectorAll('.ashby-application-form-input-yesno').length === 1 && !choices.querySelector('input,select,textarea,a') && buttons.every(button => !button.hasAttribute('form') && !button.hasAttribute('formaction') && !['submit', 'reset'].includes(button.getAttribute('type'))) && label.length > 5 && label.length <= 600 && !/\b(?:submit|submission|finish|complete|send|confirm)\b/i.test(label)) {
      groupName = label
      ashbyBoolean = true
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
