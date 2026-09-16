import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, getPool } from '../db/client.js'
import { applications, huntCandidates, huntRunJobs, huntRuns } from '../db/schema.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { ACTIVE_CANDIDATE_STATUSES, eligibilityOf, ownedJobSelection, REVIEWABLE_RUNS, selectionBlockedReason } from '../modules/dashboard/job-policy.js'
import { assertApplicationQueueConfigured, enqueueApprovedCandidates } from './application-queue.js'
import { describeMissing, readApplyFields } from '../persona/apply-fields.js'

async function withApprovalLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  let locked = false
  try {
    const result = await client.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as locked', [`application-approval:${userId}`])
    locked = result.rows[0]?.locked === true
    if (!locked) throw conflict('Another batch is being queued. Wait for it to finish and retry.')
    return await operation()
  } finally {
    if (locked) await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [`application-approval:${userId}`])
    client.release()
  }
}

async function checkProfile(userId: string) {
  assertApplicationQueueConfigured()
  const fields = await readApplyFields(userId)
  if (!fields.hasBaseResume) throw badRequest('Upload a resume before applying — every application needs one attached.')
  if (fields.missingRequired.length) throw badRequest(`Before applying, Hunty needs your ${describeMissing(fields.missingRequired)}. Every application form asks for it.`)
}

async function approveBatch(userId: string, runId: string, selectedIds: string[]) {
  const uniqueIds = [...new Set(selectedIds)].slice(0, 100)
  if (!uniqueIds.length) throw badRequest('Select at least one job to approve.')
  const [run] = await db.select().from(huntRuns).where(and(eq(huntRuns.id, runId), eq(huntRuns.userId, userId))).limit(1)
  if (!run) throw notFound('Hunt run not found')
  if (!REVIEWABLE_RUNS.includes(run.status as typeof REVIEWABLE_RUNS[number])) throw badRequest('This hunt is still finding jobs. Wait for discovery to finish.')
  const selected = await db.select().from(huntCandidates).where(and(
    eq(huntCandidates.userId, userId), eq(huntCandidates.runId, runId),
    inArray(huntCandidates.id, uniqueIds), inArray(huntCandidates.status, ['discovered', 'rejected']),
  ))
  if (selected.length !== uniqueIds.length) throw badRequest('One or more selected jobs are already being processed. Refresh the list.')
  const existing = await db.select({ id: applications.id }).from(applications).where(and(eq(applications.userId, userId), inArray(applications.jobId, selected.map(r => r.jobId)))).limit(1)
  if (existing.length) throw conflict('One or more selected jobs are already in Applications. Refresh the list.')

  // Preserve match decisions before advancing application state. Crucially, do
  // not reject the rest of the hunt just because this batch did not select it.
  await db.update(huntRunJobs).set({
    eligibilityStatus: sql`coalesce(${huntRunJobs.eligibilityStatus}, case when ${huntRunJobs.status}::text in ('scraped','eligible','below_threshold','deal_breaker','role_mismatch','seniority_mismatch','experience_mismatch','insufficient_skills','location_mismatch') then ${huntRunJobs.status}::text else 'eligible' end)`,
    status: 'approved', updatedAt: new Date(),
  }).where(and(eq(huntRunJobs.userId, userId), eq(huntRunJobs.runId, runId), inArray(huntRunJobs.jobId, selected.map(r => r.jobId))))
  await db.update(huntCandidates).set({ status: 'approved', updatedAt: new Date() }).where(and(eq(huntCandidates.userId, userId), inArray(huntCandidates.id, uniqueIds)))
  const queued = await enqueueApprovedCandidates(userId, runId, uniqueIds)
  return { selected: uniqueIds.length, ...queued }
}

export async function approveDailyBatch(userId: string, runId: string, selectedIds: string[]) {
  await checkProfile(userId)
  return withApprovalLock(userId, () => approveBatch(userId, runId, selectedIds))
}

export type SelectedScrapedJob = { jobId: string; runId: string }
export async function approveScrapedJobs(userId: string, input: SelectedScrapedJob[]) {
  await checkProfile(userId)
  return withApprovalLock(userId, async () => {
    const requested = [...new Map(input.map(r => [r.jobId, r])).values()].slice(0, 100)
    const rows = await db.select({ row: huntRunJobs, runStatus: huntRuns.status, candidate: huntCandidates, applicationStatus: applications.status })
      .from(huntRunJobs).innerJoin(huntRuns, and(eq(huntRuns.id, huntRunJobs.runId), eq(huntRuns.userId, userId)))
      .leftJoin(huntCandidates, and(eq(huntCandidates.userId, userId), eq(huntCandidates.runId, huntRunJobs.runId), eq(huntCandidates.jobId, huntRunJobs.jobId)))
      .leftJoin(applications, and(eq(applications.userId, userId), eq(applications.jobId, huntRunJobs.jobId)))
      .where(and(eq(huntRunJobs.userId, userId), inArray(huntRunJobs.jobId, requested.map(r => r.jobId))))
    const ownedRows = ownedJobSelection(userId, requested, rows.map(entry => ({ ...entry, ...entry.row })))
    const owned = ownedRows ?? []
    // Validate the entire batch before writing anything, including mixed-owner batches.
    if (!ownedRows) throw notFound('One or more jobs were not found in your hunts.')
    const active = await db.select({ jobId: huntCandidates.jobId }).from(huntCandidates)
      .where(and(eq(huntCandidates.userId, userId), inArray(huntCandidates.jobId, requested.map(r => r.jobId)), inArray(huntCandidates.status, [...ACTIVE_CANDIDATE_STATUSES])))
    const activeJobs = new Set(active.map(r => r.jobId))
    const groups = new Map<string, string[]>()
    const skipped: Array<{ jobId: string; reason: string }> = []
    for (const entry of owned) {
      if (!entry) continue
      const { row, runStatus, candidate, applicationStatus } = entry
      const reason = selectionBlockedReason({ runStatus, status: row.status, applicationStatus, activeCandidate: activeJobs.has(row.jobId), reasons: row.reasons })
      if (reason) { skipped.push({ jobId: row.jobId, reason }); continue }
      await db.update(huntRunJobs).set({ eligibilityStatus: eligibilityOf(row.status, row.eligibilityStatus, Boolean(candidate)) }).where(eq(huntRunJobs.id, row.id))
      let candidateId = candidate?.id
      if (!candidateId) {
        const [created] = await db.insert(huntCandidates).values({ userId, runId: row.runId, jobId: row.jobId, sourcePortal: row.sourcePortal, score: row.score ?? 0, scoreBreakdown: row.scoreBreakdown ?? {}, reasons: row.reasons, status: 'discovered' }).onConflictDoNothing().returning({ id: huntCandidates.id })
        candidateId = created?.id
      }
      if (!candidateId) { skipped.push({ jobId: row.jobId, reason: 'Job changed while preparing. Refresh and retry.' }); continue }
      groups.set(row.runId, [...(groups.get(row.runId) ?? []), candidateId])
    }
    const queuedJobIds: string[] = []
    let capped = false
    for (const [runId, ids] of groups) {
      const result = await approveBatch(userId, runId, ids)
      queuedJobIds.push(...result.queuedJobIds)
      skipped.push(...result.skipped)
      capped ||= result.capped
    }
    return { selected: requested.length, queued: queuedJobIds.length, queuedJobIds, capped, skipped }
  })
}
