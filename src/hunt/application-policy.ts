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
export function safeRetryReason(status: string, attempts: Array<{status: string; submitStartedAt?: Date | null; error?: string | null; submittedFields?: unknown}>, events: Array<{state: string; detail?: unknown}>) {
  if (!['failed', 'needs_review', 'closed'].includes(status)) return 'Only failed, cancelled, or review applications can be retried.'
  if (attempts.some(a => a.submitStartedAt)) return 'A submit was attempted. Check the provider; automatic retry is unsafe.'
  if (attempts.some(a => ['submitted', 'submitted_unconfirmed', 'unknown', 'submitting', 'pending'].includes(a.status) && !(a.status === 'unknown' && ['Not submitted: dry_run','Not submitted: kill_switch'].includes(a.error ?? '') && !a.submitStartedAt))) return 'Submission is completed or uncertain. Check the provider; automatic retry is unsafe.'
  if (events.some(e => (e.state === 'submitting' && (e.detail as {dryRun?:boolean}|null)?.dryRun !== true) || e.state === 'submitted')) return 'A submit was attempted. This application cannot be retried automatically.'
  return null
}

export class ApplicationDeferredError extends Error {
  constructor(message = 'Browser is busy with account setup. Application remains queued.') { super(message); this.name = 'ApplicationDeferredError' }
}
