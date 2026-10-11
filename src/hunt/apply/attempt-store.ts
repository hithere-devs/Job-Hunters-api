import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { applicationDispatches, applicationEvents, applications, applyAttempts, huntCandidates, huntRunJobs, huntRuns } from '../../db/schema.js'
import { env } from '../../config/env.js'
import { runnerVersion } from '../../lib/build-info.js'
import { FAILURE_COPY, retryDelayMs, type FailureClass } from './failure.js'
import type { SubmitOutcome } from './confirmation.js'

/**
 * Every terminal write for an attempt, in one transaction.
 *
 * The attempt, candidate, application, run-job row and run counters used to be
 * written one statement at a time; a failure between them left pages that
 * disagreed with each other. The attempt row is the authority: its
 * `completed_at` turning non-null is the single transition that counters
 * follow, so a repeated call cannot double-count.
 */

export type AttemptOutcome =
  /** Positive confirmation from the provider. */
  | 'submitted'
  /** Stopped before submitting; needs the user or a retry. */
  | 'needs_review'
  /** A click happened and its result is unknown, or a deliberate dry run. */
  | 'unknown'
  /** The posting is gone. */
  | 'closed'
  /** Transient failure; queued again with backoff. */
  | 'retry'

export interface AttemptContext {
  attemptId: string
  userId: string
  candidateId: string
  applicationId: string
  runId: string
  jobId: string
  portal: string
  retryIndex: number
}

export async function previousTransientRetries(candidateId: string): Promise<number> {
  const rows = await db.select({ failureClass: applyAttempts.failureClass }).from(applyAttempts)
    .where(eq(applyAttempts.candidateId, candidateId)).orderBy(desc(applyAttempts.createdAt)).limit(10)
  let count = 0
  for (const row of rows) {
    if (row.failureClass !== 'transient') break
    count += 1
  }
  return count
}

export async function createAttempt(params: { candidateId: string; userId: string; portalId: string; retryIndex: number }) {
  const [attempt] = await db.insert(applyAttempts).values({
    candidateId: params.candidateId,
    userId: params.userId,
    portalId: params.portalId,
    // `submitting` is reserved for the moment the durable fence is written.
    status: 'pending',
    retryIndex: params.retryIndex,
    runnerVersion: runnerVersion(),
    startedAt: new Date(),
  }).returning()
  if (!attempt) throw new Error('Could not create application intent')
  return attempt
}

export async function finishAttempt(context: AttemptContext, result: {
  outcome: AttemptOutcome
  failureClass?: FailureClass | null
  submitOutcome?: SubmitOutcome | 'confirmed_by_email' | null
  error?: string | null
  note?: string | null
  submittedFields?: unknown
  unresolvedFields?: unknown
  evidenceStoragePath?: string | null
  answerPlan?: unknown
  schemaSource?: string | null
}): Promise<{ finished: boolean; retryAt?: Date }> {
  const now = new Date()
  const attemptStatus = result.outcome === 'submitted' ? 'submitted' as const
    : result.outcome === 'unknown' ? 'unknown' as const
      : result.outcome === 'retry' ? 'failed' as const
        : 'needs_review' as const
  const candidateStatus = result.outcome === 'submitted' ? 'applied' as const
    : result.outcome === 'retry' ? 'queued' as const
      : result.outcome === 'closed' ? 'failed' as const
        : 'needs_review' as const
  const applicationStatus = result.outcome === 'submitted' ? 'applied' as const
    : result.outcome === 'retry' ? 'queued' as const
      : result.outcome === 'closed' ? 'closed' as const
        : 'needs_review' as const
  const note = result.note ?? (result.failureClass ? FAILURE_COPY[result.failureClass] : null)
  const retryAt = result.outcome === 'retry' ? new Date(now.getTime() + retryDelayMs(context.retryIndex)) : undefined

  return db.transaction(async (tx) => {
    const [closed] = await tx.update(applyAttempts).set({
      status: attemptStatus,
      failureClass: result.failureClass ?? null,
      ...(result.submitOutcome !== undefined ? { submitOutcome: result.submitOutcome } : {}),
      error: result.error ?? null,
      ...(result.submittedFields !== undefined ? { submittedFields: result.submittedFields } : {}),
      ...(result.unresolvedFields !== undefined ? { unresolvedFields: result.unresolvedFields } : {}),
      ...(result.evidenceStoragePath !== undefined ? { evidenceStoragePath: result.evidenceStoragePath } : {}),
      ...(result.answerPlan !== undefined ? { answerPlan: result.answerPlan } : {}),
      ...(result.schemaSource !== undefined ? { schemaSource: result.schemaSource } : {}),
      completedAt: now,
      updatedAt: now,
    }).where(and(eq(applyAttempts.id, context.attemptId), isNull(applyAttempts.completedAt))).returning({ id: applyAttempts.id })
    if (!closed) return { finished: false }

    const [previous] = await tx.select({ status: applications.status }).from(applications).where(eq(applications.id, context.applicationId)).limit(1)
    await tx.update(huntCandidates).set({ status: candidateStatus, updatedAt: now }).where(eq(huntCandidates.id, context.candidateId))
    await tx.update(applications).set({
      status: applicationStatus,
      ...(result.outcome === 'submitted' ? { appliedAt: now } : {}),
      ...(note ? { notes: note } : {}),
      updatedAt: now,
    }).where(eq(applications.id, context.applicationId))
    await tx.update(huntRunJobs).set({ status: candidateStatus === 'failed' ? 'needs_review' : candidateStatus, updatedAt: now })
      .where(and(eq(huntRunJobs.runId, context.runId), eq(huntRunJobs.jobId, context.jobId)))
    if (result.outcome === 'submitted') {
      await tx.update(huntRuns).set({ applicationsSubmitted: sql`${huntRuns.applicationsSubmitted} + 1`, updatedAt: now }).where(eq(huntRuns.id, context.runId))
    } else if (result.outcome === 'needs_review' || result.outcome === 'unknown') {
      await tx.update(huntRuns).set({ applicationsNeedsReview: sql`${huntRuns.applicationsNeedsReview} + 1`, updatedAt: now }).where(eq(huntRuns.id, context.runId))
    }
    if (previous && previous.status !== applicationStatus) {
      await tx.insert(applicationEvents).values({ applicationId: context.applicationId, fromStatus: previous.status, toStatus: applicationStatus, note: note ?? null })
    }
    if (retryAt) {
      // A fresh durable intent; the dispatcher publishes it once `not_before` passes.
      await tx.update(applicationDispatches).set({ cancelledAt: now, updatedAt: now })
        .where(and(eq(applicationDispatches.candidateId, context.candidateId), isNull(applicationDispatches.cancelledAt)))
      await tx.insert(applicationDispatches).values({ userId: context.userId, runId: context.runId, candidateId: context.candidateId, portal: context.portal, queueName: env.APPLICATION_QUEUE_NAME, notBefore: retryAt })
    }
    return { finished: true, ...(retryAt ? { retryAt } : {}) }
  })
}

/** Persist the click outcome as soon as it is known, independently of the final write. */
export async function recordSubmitOutcome(attemptId: string, outcome: SubmitOutcome | 'confirmed_by_email') {
  await db.update(applyAttempts).set({ submitOutcome: outcome, updatedAt: new Date() }).where(eq(applyAttempts.id, attemptId))
}
