import { Queue } from 'bullmq'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { env } from '../config/env.js'
import { db, closeDatabase } from '../db/client.js'
import { applicationDispatches, applications, applyAttempts, attemptEvents, huntCandidates } from '../db/schema.js'
import { getRedis, closeRedis } from '../lib/redis.js'

const userId = '1d4f5036-09a1-4df5-8509-e3ac99626b80'

async function main() {
  const redis = getRedis()
  const queue = new Queue(env.APPLICATION_QUEUE_NAME, { connection: redis })
  const counts = await queue.getJobCounts()
  const jobs = await queue.getJobs(['active', 'waiting', 'delayed'])
  const listed = []
  for (const job of jobs) {
    const state = await job.getState()
    const lockTtl = await redis.pttl(queue.toKey(`${job.id}:lock`))
    listed.push({
      id: job.id,
      name: job.name,
      state,
      lockTtl,
      candidateId: job.data.candidateId,
      dispatchId: job.data.dispatchId,
      timestamp: new Date(job.timestamp).toISOString(),
      processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    })
  }
  const lockKeys = await redis.keys('huntly:*')
  const lockValues: Record<string, string | number | null> = {}
  for (const key of lockKeys.slice(0, 80)) {
    const type = await redis.type(key)
    lockValues[key] = type === 'string' ? await redis.get(key) : `type:${type}`
    if (type === 'string') lockValues[`${key}:pttl`] = await redis.pttl(key)
  }
  const applying = await db.select({
    candidateId: huntCandidates.id,
    status: huntCandidates.status,
    updatedAt: huntCandidates.updatedAt,
    jobId: huntCandidates.jobId,
    runId: huntCandidates.runId,
  }).from(huntCandidates).where(and(eq(huntCandidates.userId, userId), inArray(huntCandidates.status, ['queued', 'applying'])))
  const extra = []
  for (const row of applying) {
    const [app] = await db.select({ id: applications.id, company: applications.company, role: applications.role, status: applications.status })
      .from(applications).where(and(eq(applications.userId, userId), eq(applications.jobId, row.jobId))).limit(1)
    const [attempt] = await db.select({
      id: applyAttempts.id,
      status: applyAttempts.status,
      updatedAt: applyAttempts.updatedAt,
      createdAt: applyAttempts.createdAt,
      error: applyAttempts.error,
    }).from(applyAttempts).where(and(eq(applyAttempts.candidateId, row.candidateId), eq(applyAttempts.userId, userId)))
      .orderBy(desc(applyAttempts.createdAt)).limit(1)
    const events = attempt
      ? await db.select({ state: attemptEvents.state, reason: attemptEvents.reason, at: attemptEvents.at })
        .from(attemptEvents).where(eq(attemptEvents.attemptId, attempt.id)).orderBy(desc(attemptEvents.at)).limit(8)
      : []
    const [dispatch] = await db.select({
      id: applicationDispatches.id,
      cancelledAt: applicationDispatches.cancelledAt,
      createdAt: applicationDispatches.createdAt,
    }).from(applicationDispatches).where(and(eq(applicationDispatches.candidateId, row.candidateId), eq(applicationDispatches.userId, userId)))
      .orderBy(desc(applicationDispatches.createdAt)).limit(1)
    extra.push({
      company: app?.company,
      role: app?.role,
      appStatus: app?.status,
      candidate: row.status,
      candidateUpdatedAt: row.updatedAt.toISOString(),
      attempt: attempt?.status,
      attemptUpdatedAt: attempt?.updatedAt?.toISOString() ?? null,
      events: events.map((event) => ({ state: event.state, reason: event.reason, at: event.at.toISOString() })),
      dispatchId: dispatch?.id ?? null,
      dispatchCancelled: Boolean(dispatch?.cancelledAt),
    })
  }
  console.log(JSON.stringify({ queue: env.APPLICATION_QUEUE_NAME, counts, jobs: listed, lockKeys: lockKeys.length, lockValues, extra }, null, 2))
  await queue.close()
}

main().finally(async () => { await closeRedis(); await closeDatabase() })
