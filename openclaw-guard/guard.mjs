import { open, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'

const credential = /password|passcode|one.?time|\botp\b|verification.?code|security.?code|recovery.?code|api.?key|access.?token|refresh.?token|captcha|not.?a.?robot|human.?verification|verify.{0,20}human|(?:i am|i.m|you are|you.re).{0,10}human|secret/i
const sensitive = /sponsor|visa|citizen|nationality|authori[sz]|eligible to work|right to work|permission to work|gender|pronoun|ethnic|race|hispanic|latino|disabilit|veteran|sexual|salary|compensation|\bctc\b|criminal|convict|background|non.?compete|legal obligation/i
const never = /criminal|convict|background check|non.?compete|legal obligation|certify|attest|swear|declaration/i
const final = /submit|finish|complete|send|confirm|apply|accept offer/i
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
const deny = (reason) => ({ block: true, blockReason: `huntly_guard:${reason}` })

export async function readPolicy(path, tenant, now = Date.now()) {
  if (!Number.isInteger(tenant) || tenant < 1 || tenant > 10 || path !== `/run/huntly-openclaw/tenant-${tenant}.json`) throw new Error('policy_identity')
  const directory = await lstat('/run/huntly-openclaw')
  if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o777) !== 0o711) throw new Error('policy_directory_permissions')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_000_000 || (stat.mode & 0o777) !== 0o640 || stat.uid !== 0 || stat.gid !== process.getgid?.()) throw new Error('policy_permissions')
    const policy = JSON.parse(await handle.readFile('utf8'))
    validatePolicy(policy, now)
    return policy
  } finally { await handle.close() }
}
export function assertRunContext(policy, context) {
  if (context?.sessionKey !== `agent:main:huntly-apply-${policy.attemptId}`) throw new Error('policy_session_mismatch')
}
export function validatePolicy(p, now = Date.now()) {
  if (!p || typeof p.attemptId !== 'string' || !p.attemptId || typeof p.targetId !== 'string' || !p.targetId || !Number.isSafeInteger(p.deadlineEpoch) || p.deadlineEpoch <= now || p.deadlineEpoch > now + 660_000) throw new Error('policy_missing_or_expired')
  if (!Array.isArray(p.allowedHosts) || !p.allowedHosts.length || p.allowedHosts.some(h => typeof h !== 'string' || !/^[a-z0-9.-]+$/.test(h) || h.includes('..'))) throw new Error('policy_hosts')
  if (!Array.isArray(p.approvedFields) || p.approvedFields.some(f => !f || typeof f.label !== 'string' || typeof f.type !== 'string' || typeof f.value !== 'string')) throw new Error('policy_fields')
  if (p.resumePath !== null && p.resumePath !== undefined && (typeof p.resumePath !== 'string' || !p.resumePath.startsWith('/'))) throw new Error('policy_resume')
}
function hostAllowed(url, p) {
  try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && p.allowedHosts.includes(u.hostname.toLowerCase()) } catch { return false }
}
function approved(p, node, value) {
  return p.approvedFields.some(f => norm(f.label) === norm(node.label) && norm(f.type) === norm(node.type) && f.value === value)
}
function fieldCheck(node, value, p) {
  if (!node || !node.visible || node.disabled || !node.label || credential.test(`${node.label} ${node.type}`)) return 'credential_or_unknown_field'
  if (never.test(node.label)) return 'legal_declaration'
  if (sensitive.test(node.label) && !approved(p, node, value)) return 'sensitive_value_not_explicitly_approved'
  return null
}
/** Facts and resolveRef are host-observed. Never use model-supplied labels or types. */
export async function decide(event, policy, facts, resolveRef, now = Date.now(), routing = {}) {
  try { validatePolicy(policy, now) } catch { return deny('policy_missing_or_expired') }
  if (event.toolName !== 'browser') return deny('tool_not_browser')
  const profileName = routing.profileName ?? 'tenant'
  if (!['tenant', 'extension-test'].includes(profileName)) return deny('unsupported_browser_profile')
  const p = event.params
  if (!p || typeof p !== 'object' || Array.isArray(p)) return deny('invalid_parameters')
  if (p.node || (p.target && p.target !== 'host') || (p.profile && p.profile !== profileName)) return deny('wrong_tenant_route')
  if (p.targetId && p.targetId !== policy.targetId) return deny('wrong_tab')
  if (!facts || facts.targetId !== policy.targetId || !hostAllowed(facts.url, policy) || facts.frameUrls.some(url => url !== 'about:blank' && !hostAllowed(url, policy))) return deny('unapproved_page')
  if (facts.hasAuthentication) return deny('human_authentication_required')
  // Restrict the envelope as well as the action so future tool parameters fail closed.
  const route = { target: 'host', profile: profileName, targetId: policy.targetId }
  if (p.action === 'snapshot') return { params: { action: 'snapshot', ...route, snapshotFormat: 'ai', refs: 'aria', interactive: false, compact: false, maxChars: 18000 } }
  if (p.action === 'screenshot') return { params: { action: 'screenshot', ...route, fullPage: false, type: 'png' } }
  if (p.action === 'upload') {
    if (!policy.resumePath || !Array.isArray(p.paths) || p.paths.length !== 1 || p.paths[0] !== policy.resumePath || typeof p.inputRef !== 'string' || p.ref || p.element) return deny('upload_must_target_approved_file_input')
    const node = await resolveRef(p.inputRef)
    if (node.type !== 'file' || node.tag !== 'input' || node.disabled || credential.test(node.label)) return deny('invalid_upload_input')
    return { params: { action: 'upload', ...route, paths: [policy.resumePath], inputRef: p.inputRef } }
  }
  if (p.action !== 'act') return deny('action_not_allowed')
  const r = p.request ?? p
  if (!r || typeof r !== 'object' || Array.isArray(r) || (r.targetId && r.targetId !== policy.targetId)) return deny('invalid_or_wrong_tab_action')
  if (r.submit || r.modifiers?.length || r.doubleClick || r.button && r.button !== 'left') return deny('implicit_submission_or_modified_action')
  const request = { targetId: policy.targetId, timeoutMs: 5000 }
  if (r.kind === 'fill') {
    if (!Array.isArray(r.fields) || !r.fields.length || r.fields.length > 40) return deny('invalid_fill_use_fields_array_or_kind_type_with_ref_and_text')
    const fields = []
    for (const field of r.fields) {
      if (typeof field.ref !== 'string' || typeof field.value !== 'string') return deny('invalid_fill_field')
      const node = await resolveRef(field.ref)
      const reason = fieldCheck(node, field.value, policy)
      if (reason) return deny(reason)
      if (!['input', 'textarea', 'select'].includes(node.tag) || ['submit', 'button', 'reset', 'file', 'hidden'].includes(node.type)) return deny('not_fillable')
      fields.push({ ref: field.ref, type: node.type === 'checkbox' ? 'checkbox' : node.type === 'radio' ? 'radio' : node.tag === 'select' ? 'select' : 'text', value: field.value })
    }
    return { params: { action: 'act', ...route, request: { ...request, kind: 'fill', fields } } }
  }
  if (typeof r.ref !== 'string' || !/^(?:f\d+)?(?:e|ax)?\d+$/.test(r.ref)) return deny('reference_required')
  const node = await resolveRef(r.ref)
  if (!node || !node.visible || node.disabled) return deny('unavailable_element')
  if (r.kind === 'type') {
    if (typeof r.text !== 'string') return deny('text_required')
    const reason = fieldCheck(node, r.text, policy)
    if (reason) return deny(reason)
    if (!['input', 'textarea'].includes(node.tag) || ['checkbox', 'radio', 'submit', 'button', 'file', 'hidden', 'reset'].includes(node.type)) return deny('not_text_input')
    return { params: { action: 'act', ...route, request: { ...request, kind: 'type', ref: r.ref, text: r.text, slowly: false, submit: false } } }
  }
  if (r.kind === 'select') {
    if (!Array.isArray(r.values) || r.values.length !== 1 || typeof r.values[0] !== 'string' || node.tag !== 'select') return deny('invalid_select')
    const reason = fieldCheck(node, r.values[0], policy)
    if (reason) return deny(reason)
    return { params: { action: 'act', ...route, request: { ...request, kind: 'select', ref: r.ref, values: r.values } } }
  }
  if (r.kind === 'click') {
    if (credential.test(`${node.label} ${node.name}`) || never.test(`${node.label} ${node.name}`)) return deny('credential_or_legal_control')
    if (['checkbox', 'radio', 'option'].includes(node.type) || ['checkbox', 'radio', 'option'].includes(node.role)) {
      if (!node.choiceContext) return deny('choice_question_context_unknown')
      if (node.autocompleteChoice && sensitive.test(node.label)) return deny('sensitive_autocomplete_not_allowed')
      const value = node.choiceValue ?? (node.type === 'checkbox' ? String(!node.checked) : node.name)
      const reason = fieldCheck(node, value, policy)
      if (reason) return deny(reason)
    } else if ((node.tag === 'button' || node.role === 'button') && /^(?:next|continue|next step)$/i.test(node.name.trim()) && facts.wizardStep && facts.wizardStep.current < facts.wizardStep.total && !final.test(node.name)) {
      // Positive step counter required; a generic Continue on a final form is denied.
    } else if (['input', 'textarea', 'select'].includes(node.tag) && !['submit', 'reset', 'button', 'file', 'hidden'].includes(node.type) && !sensitive.test(node.label)) {
      // Opening a normal select / focusing a text field is harmless.
    } else return deny('final_submit_or_unproven_click')
    return { params: { action: 'act', ...route, request: { ...request, kind: 'click', ref: r.ref, button: 'left' } } }
  }
  if (r.kind === 'scrollIntoView') return { params: { action: 'act', ...route, request: { ...request, kind: 'scrollIntoView', ref: r.ref } } }
  return deny('action_kind_not_allowed')
}
