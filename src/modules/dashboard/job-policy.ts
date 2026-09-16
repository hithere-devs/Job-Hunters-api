/** Match quality is independent of whether an application has been queued. */
export const ELIGIBILITY_STATUSES = [
  'eligible', 'scraped', 'role_mismatch', 'seniority_mismatch', 'experience_mismatch',
  'insufficient_skills', 'location_mismatch', 'below_threshold', 'deal_breaker',
] as const
export const REVIEWABLE_RUNS = ['awaiting_approval', 'applying', 'paused', 'completed', 'stopped', 'failed'] as const
export const ACTIVE_CANDIDATE_STATUSES = ['approved', 'tailored', 'queued', 'applying', 'applied', 'needs_review', 'failed'] as const

export function eligibilityOf(status: string, stored: string | null, hasCandidate: boolean): string {
  if (stored && ELIGIBILITY_STATUSES.includes(stored as typeof ELIGIBILITY_STATUSES[number])) return stored
  if (ELIGIBILITY_STATUSES.includes(status as typeof ELIGIBILITY_STATUSES[number])) return status
  // Legacy candidates were only created for accepted matches. This fallback
  // restores the old shortlist without rewriting application history.
  return hasCandidate ? 'eligible' : 'scraped'
}

export function selectionBlockedReason(input: {
  runStatus: string; status: string; applicationStatus: string | null;
  activeCandidate: boolean; reasons: string[];
}): string | null {
  if (input.applicationStatus) return 'Already in Applications. Review its progress there.'
  if (input.status === 'closed') return 'This job is closed.'
  if (input.activeCandidate) return 'Already being processed. Review it in Applications.'
  if (!REVIEWABLE_RUNS.includes(input.runStatus as typeof REVIEWABLE_RUNS[number])) return 'This hunt is still finding jobs. Select it when discovery finishes.'
  if (input.reasons.includes('no_applyable_url')) return 'No direct application URL found. Open the source to apply manually.'
  return null
}

// Legacy scrapes may predate the discovery guard. Recheck at manual approval.
export const AGGREGATOR_URL_PATTERN = '^https?://([^/]+\\.)?(adzuna\\.[a-z.]+|jooble\\.org|weworkremotely\\.com|jobicy\\.com|arbeitnow\\.[a-z.]+|remoteok\\.com|remotive\\.com)([:/]|$)'
export function isAggregatorApplicationUrl(url: string): boolean {
  return new RegExp(AGGREGATOR_URL_PATTERN, 'i').test(url)
}

export function ownedJobSelection<T extends { userId: string; runId: string; jobId: string }>(
  userId: string, requested: Array<{ runId: string; jobId: string }>, rows: T[],
): T[] | null {
  const selected = requested.map(wanted => rows.find(row => row.userId === userId && row.runId === wanted.runId && row.jobId === wanted.jobId))
  return selected.every((row): row is T => row !== undefined) ? selected : null
}
