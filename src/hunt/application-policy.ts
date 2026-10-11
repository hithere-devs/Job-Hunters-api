/** Budget is UTC calendar-day based, shared across hunts and queue batches. */
export function dailyBudget(used: number, configured = 100, now = new Date()) {
  const limit = Math.max(1, Math.min(100, configured))
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return { limit, used, remaining: Math.max(0, limit - used), start, resetsAt: new Date(start.getTime() + 86_400_000).toISOString() }
}
export function effectiveConcurrency(configured: number, vmProfile: boolean) {
  return vmProfile ? 1 : Math.max(1, Math.min(4, configured))
}
export interface RetryAttemptEvidence {
  status: string
  submitStartedAt?: Date | null
  submitOutcome?: string | null
  failureClass?: string | null
  error?: string | null
  submittedFields?: unknown
}

const FENCED_RETRY = 'A submit may have reached the employer. Check with the employer that no application was received, then confirm that to retry.'
const SUBMITTED_RETRY = 'This application was submitted. Retrying would send a duplicate.'

/**
 * Never retry evidence that may represent a completed external submission.
 *
 * The durable fence decides, not the caller's say-so: `confirmedNotSubmitted`
 * (which the UI sends on every retry) no longer unlocks a fenced attempt. Only
 * an explicit `providerChecked` acknowledgement does, and only when the click
 * was not provably rejected.
 */
export function safeRetryReason(
  status: string,
  attempts: RetryAttemptEvidence[],
  events: Array<{state: string; detail?: unknown; reason?: string | null}>,
  options?: {confirmedNotSubmitted?: boolean; providerChecked?: boolean},
) {
  if (!['failed', 'needs_review', 'closed'].includes(status)) return 'Only failed, cancelled, or review applications can be retried.'
  const latest = attempts[0]
  if (!latest) return null
  const spam = latest.failureClass === 'provider_rejected'
    || /(?:flagged|rejected this submission) as possible spam/i.test(latest.error ?? '')
    || events.some((event) => event.reason === 'provider_blocked')
  if (spam) return 'The provider rejected this submission as possible spam. Automatic retry is disabled.'
  if (latest.status === 'submitted' || ['confirmed', 'confirmed_by_email'].includes(latest.submitOutcome ?? '') || events.some((event) => event.state === 'submitted')) {
    return SUBMITTED_RETRY
  }
  if (['submitting', 'pending'].includes(latest.status)) {
    return 'This attempt is still running or stopped mid-submit. Check the provider; automatic retry is unsafe.'
  }
  const liveSubmitEvent = events.some((event) => event.state === 'submitting' && (event.detail as {dryRun?: boolean} | null)?.dryRun !== true)
  const fenced = Boolean(latest.submitStartedAt) || liveSubmitEvent
  const provablyRejected = ['rejected_validation', 'verification_required', 'captcha_required'].includes(latest.submitOutcome ?? '')
  if (fenced && !provablyRejected) return options?.providerChecked ? null : FENCED_RETRY
  if (latest.status === 'unknown' && !latest.failureClass) {
    // Rows written before the fence moved ahead of the click: an `unknown`
    // with no class may hide a click. Pre-submit evidence clears it.
    const preSubmit = /Not submitted: (?:invalid_fields|no_form|dry_run|kill_switch|no_submit_control|posting_closed)|worker stopped before this attempt completed/i.test(latest.error ?? '')
    if (!preSubmit) return options?.providerChecked ? null : 'The outcome of this attempt is unknown. Check the provider; automatic retry is unsafe.'
  }
  return null
}

export class ApplicationDeferredError extends Error {
  constructor(message = 'Browser is busy with account setup. Application remains queued.') { super(message); this.name = 'ApplicationDeferredError' }
}
