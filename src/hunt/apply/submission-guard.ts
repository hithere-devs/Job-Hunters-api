import { AsyncLocalStorage } from 'node:async_hooks'
import type { SubmitOutcome } from './confirmation.js'

interface SubmissionScope {
  before: () => Promise<void>
  onOutcome?: (outcome: SubmitOutcome, reason: string) => Promise<void>
  attempted: boolean
  lastOutcome: SubmitOutcome | null
}

const submissionScope = new AsyncLocalStorage<SubmissionScope>()

/**
 * The browser click is not invoked unless the irreversible intent is durable.
 * `before` writes the fence; `onOutcome` records what the click produced.
 */
export function withSubmissionGuard<T>(
  operation: () => Promise<T>,
  before: () => Promise<void>,
  onOutcome?: (outcome: SubmitOutcome, reason: string) => Promise<void>,
) {
  return submissionScope.run({ before, onOutcome, attempted: false, lastOutcome: null }, operation)
}

/** Call immediately before the click. Writes the durable fence first. */
export async function beforeSubmission() {
  const scope = submissionScope.getStore()
  if (!scope) return // Isolated fixtures own their own bookkeeping.
  if (scope.attempted) throw new Error('A submit was already attempted in this browser. Do not submit twice.')
  await scope.before()
  scope.attempted = true
}

export async function recordSubmissionOutcome(outcome: SubmitOutcome, reason: string) {
  const scope = submissionScope.getStore()
  if (!scope) return
  scope.lastOutcome = outcome
  await scope.onOutcome?.(outcome, reason).catch(() => undefined)
}

/**
 * The click was provably not accepted (form still present with errors, or no
 * request left the page), or the provider is waiting for an emailed code.
 * Another click in this operation is then safe; the fence timestamp stays.
 */
export function releaseSubmissionAfterRejection() {
  const scope = submissionScope.getStore()
  if (!scope) return
  if (scope.lastOutcome !== 'rejected_validation' && scope.lastOutcome !== 'verification_required' && scope.lastOutcome !== 'captcha_required') {
    throw new Error('Only a provably rejected click may be retried.')
  }
  scope.attempted = false
}

export function submissionWasAttempted() { return submissionScope.getStore()?.attempted ?? false }
export function lastSubmissionOutcome() { return submissionScope.getStore()?.lastOutcome ?? null }

/** True when some click in this operation may have reached the provider. */
export function submissionMayHaveReachedProvider() {
  const scope = submissionScope.getStore()
  if (!scope) return false
  return scope.attempted || (scope.lastOutcome !== null && scope.lastOutcome !== 'rejected_validation' && scope.lastOutcome !== 'captcha_required')
}

/** Unexpected provider confirmation after a step/choice is irreversible evidence too. */
export async function noteUnexpectedSubmission() {
  const scope = submissionScope.getStore()
  if (!scope || scope.attempted) return
  scope.attempted = true
  await scope.before()
}
