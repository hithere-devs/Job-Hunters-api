import type { Page } from 'playwright-core'
import { capturePageState } from '../confirmation.js'
import type { PilotSnapshot } from '../pilot-page.js'
import type { PlannedAnswer } from './answers.js'
import type { FieldResult } from './executor.js'
import type { FieldMatch } from './match.js'
import type { SchemaField } from './schema/types.js'

/**
 * The only door to the submit button.
 *
 * Production's single largest failure was a form submitted with required
 * fields known to be empty, which then failed validation and was recorded as
 * an unexplained "Submit control" problem. Nothing is clicked now unless every
 * required field verifiably holds a value, the résumé is attached, the page
 * shows no errors and the browser's own validity check passes.
 */

export type BlockerReason = 'needs_answer' | 'unfilled_required' | 'resume_missing' | 'validation_error' | 'invalid_form' | 'no_submit_control'

export interface Blocker {
  key?: string
  label: string
  reason: BlockerReason
}

const ERROR_TEXT = /\brequired\b|please (?:enter|select|complete|fill|provide|choose|upload)|is (?:invalid|not valid)|must (?:be|select|complete)|can(?:no|')t be (?:blank|empty)|invalid (?:email|phone|format)/i

export async function evaluateSubmitGate(params: {
  page: Page
  snapshot: PilotSnapshot
  fields: SchemaField[]
  matches: FieldMatch[]
  answers: Map<string, PlannedAnswer>
  results: Map<string, FieldResult>
  resumeAttached: boolean
  submitSelector: string
}): Promise<{ ok: boolean; blockers: Blocker[] }> {
  const blockers: Blocker[] = []
  const byId = new Map(params.snapshot.elements.map((element) => [element.id, element]))
  for (const field of params.fields) {
    const answer = params.answers.get(field.key)
    if (field.required && answer?.action === 'ask') {
      blockers.push({ key: field.key, label: field.label, reason: 'needs_answer' })
      continue
    }
    if (field.kind === 'file') {
      if (field.required && field.fileRole === 'resume' && !params.resumeAttached) blockers.push({ key: field.key, label: field.label, reason: 'resume_missing' })
      continue
    }
    if (!field.required) continue
    const match = params.matches.find((row) => row.field.key === field.key)
    const live = match?.element ? byId.get(match.element.id) : undefined
    if (live && !live.filled) blockers.push({ key: field.key, label: field.label, reason: 'unfilled_required' })
  }
  // Ground truth from the page itself: anything it marks required and empty.
  const claimed = new Set(params.matches.map((match) => match.element?.id).filter(Boolean) as string[])
  for (const element of params.snapshot.elements) {
    if (!element.required || element.filled || ['button', 'link', 'file'].includes(element.role)) continue
    if (/^phone country code$/i.test(element.label)) continue
    if (claimed.has(element.id) && blockers.some((blocker) => params.matches.find((match) => match.field.key === blocker.key)?.element?.id === element.id)) continue
    blockers.push({ label: element.label, reason: 'unfilled_required' })
  }
  const state = await capturePageState(params.page, params.submitSelector)
  if (!state.submitVisible) blockers.push({ label: 'Submit button', reason: 'no_submit_control' })
  for (const text of state.errorTexts.filter((line) => ERROR_TEXT.test(line)).slice(0, 5)) blockers.push({ label: text, reason: 'validation_error' })
  const valid = await params.page.locator(params.submitSelector).first().evaluate((node) => {
    const form = node instanceof HTMLButtonElement || node instanceof HTMLInputElement ? node.form : node.closest('form')
    return !form || form.checkValidity()
  }).catch(() => true)
  if (!valid) blockers.push({ label: 'The form reports invalid fields', reason: 'invalid_form' })
  return { ok: blockers.length === 0, blockers }
}
