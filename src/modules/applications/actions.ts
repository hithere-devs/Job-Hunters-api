import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { db, runWithDatabase } from '../../db/client.js'
import { applications, applicationEvents, applicationDispatches, applyAttempts, attemptEvents, attemptFlags, huntCandidates, huntRunJobs, huntRuns, huntSpecs } from '../../db/schema.js'
import { badRequest, conflict, notFound } from '../../lib/errors.js'
import { safeRetryReason, dailyBudget } from '../../hunt/application-policy.js'
import { removeWaitingApplication, dispatchPendingApplications, applicationJobInfo } from '../../hunt/application-queue.js'
import { assertApprovalLease } from '../../hunt/approval-lock.js'
import { withApprovalLock } from '../../hunt/approval.js'
import { withDeadline } from '../../lib/deadline.js'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'

async function ownedApplication(userId: string, id: string) {
  const [app] = await db.select().from(applications).where(and(eq(applications.id,id),eq(applications.userId,userId))).limit(1)
  if (!app) throw notFound('Application not found')
  const [candidate] = app.jobId && app.huntRunId ? await db.select().from(huntCandidates).where(and(eq(huntCandidates.userId,userId),eq(huntCandidates.jobId,app.jobId),eq(huntCandidates.runId,app.huntRunId))).limit(1) : []
  if (!candidate) throw badRequest('This is a manual application record, not a queued application.')
  return { app, candidate }
}

export async function cancelApplication(userId: string, id: string) {
  return withApprovalLock(userId, async () => {
    const {app,candidate} = await ownedApplication(userId,id)
    if (app.status === 'closed' && candidate.status === 'rejected') return { cancelled: true }
    if (app.status !== 'queued' || !['approved','queued','tailored'].includes(candidate.status)) throw conflict('Only waiting applications can be cancelled. Use Flag for review for an active attempt.')
    await db.transaction(tx => runWithDatabase(tx, async () => {
      await assertApprovalLease()
      const [cancelled] = await tx.update(huntCandidates).set({status:'rejected',updatedAt:new Date()})
        .where(and(eq(huntCandidates.id,candidate.id),inArray(huntCandidates.status,['approved','queued','tailored']))).returning({id:huntCandidates.id})
      if (!cancelled) throw conflict('This application has started. Flag it for review instead.')
      // Holding the candidate row lock prevents a late dispatcher from claiming it.
      // Redis refuses removal if it is already active; the transaction then rolls back.
      await removeWaitingApplication(userId,candidate.id)
      await tx.update(applicationDispatches).set({cancelledAt:new Date(),updatedAt:new Date()}).where(and(eq(applicationDispatches.userId,userId),eq(applicationDispatches.candidateId,candidate.id)))
      await tx.update(huntCandidates).set({status:'rejected',updatedAt:new Date()}).where(eq(huntCandidates.id,candidate.id))
      await tx.update(huntRunJobs).set({status:'rejected',updatedAt:new Date()}).where(and(eq(huntRunJobs.userId,userId),eq(huntRunJobs.runId,candidate.runId),eq(huntRunJobs.jobId,candidate.jobId)))
      await tx.update(applications).set({status:'closed',notes:'Cancelled before application started.',updatedAt:new Date()}).where(eq(applications.id,id))
      await tx.insert(applicationEvents).values({applicationId:id,fromStatus:app.status,toStatus:'closed',note:'Cancelled before application started.'})
      await assertApprovalLease()
    }))
    return {cancelled:true}
  })
}

export async function retryApplication(userId: string, id: string) {
  return withApprovalLock(userId, async () => {
    const {app,candidate} = await ownedApplication(userId,id)
    const attempts = await db.select().from(applyAttempts).where(and(eq(applyAttempts.candidateId,candidate.id),eq(applyAttempts.userId,userId)))
    const events = attempts.length ? await db.select({state:attemptEvents.state,detail:attemptEvents.detail}).from(attemptEvents).where(inArray(attemptEvents.attemptId,attempts.map(a=>a.id))) : []
    const reason = safeRetryReason(app.status,attempts,events)
    if (reason) throw conflict(reason)
    const runtime = await applicationJobInfo(userId,candidate.id,candidate.runId)
    if (['active','waiting','delayed','paused'].includes(runtime.queueState)) throw conflict('This application is already in the queue.')
    await db.transaction(tx => runWithDatabase(tx, async () => {
      await assertApprovalLease()
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`application-budget:${userId}`}, 0))`)
      const [spec] = await tx.select({target:huntSpecs.dailyTarget}).from(huntSpecs).where(eq(huntSpecs.userId,userId)).limit(1)
      const [used] = await tx.select({value:count()}).from(applications).where(and(eq(applications.userId,userId),gte(applications.queuedAt,dailyBudget(0).start),sql`not (${applications.status} = 'closed' and ${applications.notes} is not distinct from 'Cancelled before application started.')`))
      const alreadyReservedToday = app.queuedAt >= dailyBudget(0).start && !(app.status === 'closed' && app.notes === 'Cancelled before application started.')
      if (!alreadyReservedToday && dailyBudget(used?.value??0,spec?.target??100).remaining===0) throw conflict('Daily application allowance is full. Retry after the next UTC reset.')
      await tx.update(applicationDispatches).set({cancelledAt:new Date(),updatedAt:new Date()}).where(eq(applicationDispatches.candidateId,candidate.id))
      await tx.insert(applicationDispatches).values({userId,runId:candidate.runId,candidateId:candidate.id,portal:candidate.sourcePortal,queueName:env.APPLICATION_QUEUE_NAME})
      await tx.update(huntCandidates).set({status:'queued',updatedAt:new Date()}).where(eq(huntCandidates.id,candidate.id))
      await tx.update(huntRunJobs).set({status:'queued',updatedAt:new Date()}).where(and(eq(huntRunJobs.userId,userId),eq(huntRunJobs.runId,candidate.runId),eq(huntRunJobs.jobId,candidate.jobId)))
      await tx.update(huntRuns).set({status:'applying',finishedAt:null,updatedAt:new Date()}).where(and(eq(huntRuns.id,candidate.runId),eq(huntRuns.userId,userId)))
      await tx.update(applications).set({status:'queued',queuedAt:new Date(),updatedAt:new Date()}).where(eq(applications.id,id))
      await tx.insert(applicationEvents).values({applicationId:id,fromStatus:app.status,toStatus:'queued',note:'Explicit safe retry requested; no earlier submit evidence exists.'})
      await assertApprovalLease()
    }))
    await withDeadline(dispatchPendingApplications(),5_000).catch(error=>logger.error({err:error},'retry dispatch saved for recovery'))
    return {queued:true}
  })
}

export async function flagApplication(userId: string, id: string, note?: string) {
  const {candidate} = await ownedApplication(userId,id)
  const [attempt] = await db.select().from(applyAttempts).where(and(eq(applyAttempts.candidateId,candidate.id),eq(applyAttempts.userId,userId))).orderBy(desc(applyAttempts.createdAt)).limit(1)
  if (!attempt) throw badRequest('There is no browser attempt to flag yet.')
  await withApprovalLock(userId, async () => {
    const [existing] = await db.select().from(attemptFlags).where(and(eq(attemptFlags.attemptId,attempt.id),eq(attemptFlags.userId,userId),eq(attemptFlags.status,'open'))).limit(1)
    if (existing) return
    await db.transaction(tx => runWithDatabase(tx, async () => {
      await assertApprovalLease()
      await tx.insert(attemptFlags).values({userId,attemptId:attempt.id,note:note??null})
      await tx.insert(applicationEvents).values({applicationId:id,toStatus:'needs_review',note:note??'Flagged for review. Future applications are paused; the current attempt is not interrupted.'})
    }))
  })
  return {flagged:true,queuePaused:true,attemptId:attempt.id}
}
