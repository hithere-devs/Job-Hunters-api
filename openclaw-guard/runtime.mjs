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
  const groupName = group?.getAttribute('aria-label') || group?.querySelector('legend')?.textContent?.trim() || ''
  const ownLabels = Array.from(element.labels || []).map(label => label.textContent?.trim() || '').join(' ')
  const label = groupName || ownLabels || element.getAttribute('aria-label') || element.getAttribute('placeholder') || name
  const role = element.getAttribute('role') || ''
  const choiceContext = Boolean(groupName || (element.getAttribute('type') === 'checkbox' && ownLabels && !/^(?:yes|no|agree|disagree|true|false)$/i.test(ownLabels.trim())))
  const box = element.getBoundingClientRect()
  const style = element.ownerDocument.defaultView.getComputedStyle(element)
  return {
    tag: element.tagName.toLowerCase(), type: element.getAttribute('type')?.toLowerCase() || (element.tagName === 'TEXTAREA' ? 'textarea' : element.tagName === 'SELECT' ? 'select' : ['radio', 'checkbox', 'option'].includes(role) ? role : 'text'),
    role, name: name || ownLabels, label, choiceContext,
    visible: box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
    disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
    checked: Boolean(element.checked) || element.getAttribute('aria-checked') === 'true',
  }
}
export function describePage() {
  // Read types and labels, not values, before allowing snapshot/screenshot.
  const credentialPattern = /password|passcode|one.?time|\botp\b|verification.?code|security.?code|recovery.?code|api.?key|access.?token|refresh.?token|captcha/i
  const fields = Array.from(document.querySelectorAll('input,textarea'))
  const hasSecret = fields.some(el => credentialPattern.test([el.getAttribute('type'), el.getAttribute('autocomplete'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('aria-label'), ...Array.from(el.labels || []).map(l => l.textContent)].join(' ')))
  const authButton = Array.from(document.querySelectorAll('button,input[type=submit]')).some(el => /^(?:sign in|log in|login|continue with google|sign in with google)$/i.test((el.textContent || el.getAttribute('aria-label') || '').trim()))
  const loginRoute = /\/(?:login|signin|sign-in|auth)(?:\/|\?|$)/i.test(location.pathname)
  const steps = (document.body?.innerText || '').match(/\bstep\s*(\d+)\s*(?:of|\/)\s*(\d+)\b/i)
  const wizardStep = steps && Number(steps[1]) > 0 && Number(steps[2]) <= 30 ? { current: Number(steps[1]), total: Number(steps[2]) } : null
  return { hasAuthentication: hasSecret || authButton || loginRoute, wizardStep }
}
export async function pageFacts(page, targetId) {
  const observed = await Promise.all(page.frames().map(frame => frame.evaluate(describePage)))
  return { targetId, url: page.url(), frameUrls: page.frames().map(frame => frame.url()), hasAuthentication: observed.some(frame => frame.hasAuthentication), wizardStep: observed[0]?.wizardStep ?? null }
}
