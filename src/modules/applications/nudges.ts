import { and, desc, eq, sql } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { applications, applyAttempts, attemptEvents, huntCandidates } from '../../db/schema.js'
import { conflict, notFound } from '../../lib/errors.js'
import { asyncHandler, ok, pathParam } from '../../lib/http.js'
import { getRedis } from '../../lib/redis.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { createNudgeCommand, nudgeMessageSchema, openClawNudgeChannel } from '../../hunt/apply/openclaw-nudges.js'
import { applicationRuntimes } from './runtime.js'

type NudgeTarget = { attemptId: string; userId: string; active: boolean; completed: boolean; submitting: boolean; lifecycle: string | null; tier: string | null }
interface Dependencies {
  target(userId: string, applicationId: string): Promise<NudgeTarget | null>
  publish(attemptId: string, message: string): Promise<number>
}
const dependencies: Dependencies = {
  async target(userId, applicationId) {
    const [row] = await db.select({ attemptId: applyAttempts.id, userId: applyAttempts.userId, completedAt: applyAttempts.completedAt, submitStartedAt: applyAttempts.submitStartedAt,
      latest: sql<{ tier?: string; lifecycle?: string } | null>`(select e.detail from ${attemptEvents} e where e.attempt_id = ${applyAttempts.id} order by e.at desc limit 1)`,
    }).from(applications)
      .innerJoin(huntCandidates, and(eq(huntCandidates.userId, userId), eq(huntCandidates.jobId, applications.jobId), eq(huntCandidates.runId, applications.huntRunId)))
      .innerJoin(applyAttempts, and(eq(applyAttempts.candidateId, huntCandidates.id), eq(applyAttempts.userId, userId)))
      .where(and(eq(applications.id, applicationId), eq(applications.userId, userId))).orderBy(desc(applyAttempts.createdAt)).limit(1)
    if (!row) return null
    const runtimes = await applicationRuntimes(userId, [applicationId])
    return { attemptId: row.attemptId, userId: row.userId, active: runtimes.get(applicationId)?.active === true, completed: row.completedAt !== null, submitting: row.submitStartedAt !== null, lifecycle: row.latest?.lifecycle ?? null, tier: row.latest?.tier ?? null }
  },
  async publish(attemptId, message) {
    // This endpoint must fail promptly when Redis is unavailable, not wait forever
    // on the BullMQ client's unlimited request retry configuration.
    const redis = getRedis().duplicate({ lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 3000, connectTimeout: 3000 })
    redis.on('error', () => undefined)
    try { await redis.connect(); return await redis.publish(openClawNudgeChannel(attemptId), JSON.stringify(createNudgeCommand(attemptId, message))) }
    finally { redis.disconnect() }
  },
}
export async function nudgeApplication(userId: string, applicationId: string, message: string, deps: Dependencies = dependencies) {
  const checked = nudgeMessageSchema.parse(message)
  const target = await deps.target(userId, applicationId)
  if (!target || target.userId !== userId) throw notFound('Application not found.')
  if (!target.active || target.completed || target.submitting || target.tier !== 'openclaw' || !['started', 'nudge_accepted', 'nudge_rejected'].includes(target.lifecycle ?? '')) throw conflict('OpenClaw is not currently filling this application. Wait for an active browser or check its status.')
  if (await deps.publish(target.attemptId, checked) < 1) throw conflict('The application runner is no longer listening. Refresh its status; the nudge was not delivered.')
  return { accepted: true, attemptId: target.attemptId, message: 'Nudge sent to the active runner. It cannot bypass application safety checks.' }
}
/** Mount before applicationsRouter at /applications. */
export const applicationNudgesRouter: Router = Router()
applicationNudgesRouter.use(requireAuth)
applicationNudgesRouter.post('/:id/nudge', validate({ params: z.object({ id: z.string().uuid() }), body: z.object({ message: nudgeMessageSchema }).strict() }), asyncHandler(async (req, res) => {
  ok(res, await nudgeApplication(currentUser(req).id, pathParam(req, 'id'), req.body.message))
}))
