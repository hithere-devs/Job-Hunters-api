import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { applications, applyAttempts, attemptEvents, huntCandidates, jobs, type ApplicationStatus } from '../../db/schema.js'
import { applicationJobInfo } from '../../hunt/application-queue.js'

export function projectedApplicationStatus(candidateStatus: string): ApplicationStatus {
  if(candidateStatus === 'applied') return 'applied'
  if(candidateStatus === 'needs_review') return 'needs_review'
  if(candidateStatus === 'failed') return 'failed'
  return 'queued'
}

/** Repairs the Applications read model only. Never requeues a job or opens Chrome. */
export async function reconcileApplicationRecords(userId: string): Promise<number> {
  const missing = await db.select({ candidate: huntCandidates, job: jobs }).from(huntCandidates)
    .innerJoin(jobs, eq(jobs.id, huntCandidates.jobId))
    .leftJoin(applications, and(eq(applications.userId, userId), eq(applications.jobId, jobs.id)))
    .where(and(eq(huntCandidates.userId, userId), inArray(huntCandidates.status, ['approved','queued','tailored','applying','applied','needs_review','failed']), isNull(applications.id), sql`not (${huntCandidates.status} = 'needs_review' and 'no_applyable_url' = any(${huntCandidates.reasons}))`))
    .orderBy(desc(huntCandidates.updatedAt))
  const latest = [...new Map([...missing].reverse().map(row => [row.job.id, row])).values()]
  if (!latest.length) return 0
  const records = await Promise.all(latest.map(async ({candidate,job}) => {
    let status = projectedApplicationStatus(candidate.status)
    let notes = 'Recovered from the saved hunt candidate. No application was retried.'
    if (status === 'queued' && Date.now() - candidate.updatedAt.getTime() > 180_000) {
      const runtime = await applicationJobInfo(userId, candidate.id, candidate.runId)
      if (runtime.queueState === 'missing' || runtime.queueState === 'failed' || runtime.queueState === 'completed') {
        status = 'needs_review'
        notes = 'The previous queue entry is no longer runnable. Check the provider before retrying; no automatic retry was made.'
      }
    }
    return { userId, jobId: job.id, huntRunId: candidate.runId, role: job.title, company: job.company,
      location: (job.locations as Array<{raw?:string}>).map(x=>x.raw).filter(Boolean).join('; '),
      jobUrl: job.applyUrl ?? job.canonicalUrl, jobDescription: job.descriptionText,
      portalName: candidate.sourcePortal, matchScore: candidate.score, status, notes,
      queuedAt: candidate.createdAt, appliedAt: status === 'applied' ? candidate.updatedAt : null }
  }))
  const inserted = await db.insert(applications).values(records).onConflictDoNothing().returning({id:applications.id})
  return inserted.length
}

export async function applicationRuntimes(userId: string, applicationIds: string[]) {
  if (!applicationIds.length) return new Map<string, ApplicationRuntime>()
  const rows = await db.selectDistinctOn([applications.id], {
    applicationId: applications.id, candidateId: huntCandidates.id, runId: huntCandidates.runId,
    candidateStatus: huntCandidates.status, attemptId: applyAttempts.id, attemptStatus: applyAttempts.status,
    startedAt: applyAttempts.startedAt, updatedAt: applyAttempts.updatedAt,
    lastState: sql<{state:string;reason:string|null;at:string}|null>`(select json_build_object('state', e.state, 'reason', e.reason, 'at', e.at) from ${attemptEvents} e where e.attempt_id = ${applyAttempts.id} order by e.at desc limit 1)`,
    error: applyAttempts.error,
  }).from(applications)
    .innerJoin(huntCandidates, and(eq(huntCandidates.userId,userId), eq(huntCandidates.jobId,applications.jobId), eq(huntCandidates.runId,applications.huntRunId)))
    .leftJoin(applyAttempts, and(eq(applyAttempts.candidateId,huntCandidates.id),eq(applyAttempts.userId,userId)))
    .where(and(eq(applications.userId,userId),inArray(applications.id,applicationIds)))
    .orderBy(applications.id,desc(applyAttempts.createdAt))
  return new Map(await Promise.all(rows.map(async row => {
    const queue = await applicationJobInfo(userId,row.candidateId,row.runId)
    const active = queue.queueState === 'active' && queue.lockActive
    const phase = active ? row.lastState?.state ?? (row.attemptId ? 'opening' : 'preparing')
      : (['missing','failed','completed'].includes(queue.queueState) || (queue.queueState === 'active' && !queue.lockActive)) && ['queued','applying','approved','tailored'].includes(row.candidateStatus) ? 'interrupted'
      : row.lastState?.state ?? row.candidateStatus
    return [row.applicationId, {...queue, phase, active, watchAvailable: active && Boolean(row.attemptId),
      attemptId: row.attemptId, reason: row.lastState?.reason ?? row.error,
      startedAt: row.startedAt?.toISOString() ?? null, lastActivityAt: row.lastState?.at ?? row.updatedAt?.toISOString() ?? null,
    }] as const
  })))
}
export type ApplicationRuntime = {
  queueState: string; scheduledFor: string | null; workerConnected: boolean; lockActive: boolean;
  phase: string; active: boolean; watchAvailable: boolean; attemptId: string | null;
  reason: string | null; startedAt: string | null; lastActivityAt: string | null;
}
