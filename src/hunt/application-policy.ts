/** Budget is UTC calendar-day based, shared across hunts and queue batches. */
export function dailyBudget(used: number, configured = 100, now = new Date()) {
  const limit = Math.max(1, Math.min(100, configured))
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return { limit, used, remaining: Math.max(0, limit - used), start, resetsAt: new Date(start.getTime() + 86_400_000).toISOString() }
}
export function effectiveConcurrency(configured: number, vmProfile: boolean) {
  return vmProfile ? 1 : Math.max(1, Math.min(4, configured))
}
/** Never retry evidence that may represent a completed external submission. */
export function safeRetryReason(
  status: string,
  attempts: Array<{status: string; submitStartedAt?: Date | null; error?: string | null; submittedFields?: unknown}>,
  events: Array<{state: string; detail?: unknown; reason?: string | null}>,
  options?: {confirmedNotSubmitted?: boolean},
) {
  if (!['failed', 'needs_review', 'closed'].includes(status)) return 'Only failed, cancelled, or review applications can be retried.'
  const latest = attempts[0]
  const spam = Boolean(latest?.error && /(?:flagged|rejected this submission) as possible spam/i.test(latest.error)) || events.some((event) => event.reason === 'provider_blocked')
  if (spam) return 'The provider rejected this submission as possible spam. Automatic retry is disabled.'
  if (latest?.status === 'submitted' || events.some((event) => event.state === 'submitted')) {
    return 'Submission is completed or uncertain. Check the provider; automatic retry is unsafe.'
  }
  if (['submitting', 'pending'].includes(latest?.status ?? '')) {
    return 'A submit was attempted. Check the provider; automatic retry is unsafe.'
  }
  const submittingLive = events.some((event) => event.state === 'submitting' && (event.detail as {dryRun?: boolean} | null)?.dryRun !== true)
  const dryRun = latest?.status === 'unknown'
    && ['Not submitted: dry_run', 'Not submitted: kill_switch'].includes(latest.error ?? '')
    && !latest.submitStartedAt
  const interrupted = /worker stopped before this attempt completed/i.test(latest?.error ?? '')
  const heldBack = /Not submitted: (?:invalid_fields|no_form|dry_run|kill_switch|no_submit_control|posting_closed)/.test(latest?.error ?? '')
  if ((heldBack || dryRun || interrupted) && !latest?.submitStartedAt && !submittingLive) return null
  if (!latest?.submitStartedAt && !submittingLive && ['needs_review', 'failed'].includes(latest?.status ?? '')) return null
  if (!latest) return null
  if (options?.confirmedNotSubmitted) return null
  if (latest.submitStartedAt) return 'A submit was attempted. Check the provider; automatic retry is unsafe.'
  if (['submitted', 'submitted_unconfirmed', 'unknown', 'submitting', 'pending'].includes(latest.status) && !dryRun) {
    return 'Submission is completed or uncertain. Check the provider; automatic retry is unsafe.'
  }
  if (submittingLive) return 'A submit was attempted. This application cannot be retried automatically.'
  return null
}

export class ApplicationDeferredError extends Error {
  constructor(message = 'Browser is busy with account setup. Application remains queued.') { super(message); this.name = 'ApplicationDeferredError' }
}
