import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Redis } from 'ioredis'
import { Queue, Worker, DelayedError, type Job as BullJob } from 'bullmq'
import { and, count, eq, gte, inArray, isNull, isNotNull, lt, notInArray, sql } from 'drizzle-orm'
import { env, hasRedis } from '../config/env.js'
import { db } from '../db/client.js'
import { applications, applicationDispatches, applicationEvents, attemptFlags, applyAttempts, huntCandidates, huntRunJobs, huntRuns, huntSpecs, jobs, userSchedules, userBrowserSessions } from '../db/schema.js'
import { isAggregatorApplicationUrl } from '../modules/dashboard/job-policy.js'
import { conflict, serviceUnavailable } from '../lib/errors.js'
import { withDeadline } from '../lib/deadline.js'
import { logger } from '../lib/logger.js'
import { stopTenant, getTenantStatus } from '../browser/vm-client.js'
import { withBrowserLifecycle } from '../browser/lifecycle.js'
import { stopBrowser } from '../browser/client.js'
import { applyApprovedCandidate } from './apply.js'
import { acquireLane, profileLaneKey } from './apply/lanes.js'
import { requiresSignedInProfile } from './apply/target.js'
import { MAX_TRANSIENT_RETRIES, classifyError, retryDelayMs } from './apply/failure.js'
import { previousTransientRetries } from './apply/attempt-store.js'
import { runnerVersion } from '../lib/build-info.js'
import os from 'node:os'

const QUEUE_NAME = env.APPLICATION_QUEUE_NAME
import { assertApprovalLease } from './approval-lock.js'
import { ApplicationDeferredError, dailyBudget, effectiveConcurrency } from './application-policy.js'
const MAX_DAILY_APPLICATIONS = 100
const INTERRUPTED_AFTER_MS = 3 * 60_000
const DEFAULT_PORTAL_CAP = 30
const PORTAL_CAPS: Record<string, number> = {
  greenhouse: 35,
  ashby: 30,
  lever: 30,
  wellfound: 15,
  instahyre: 15,
}

export interface ApplyJobData {
  dispatchId?: string
  userId: string
  runId: string
  candidateId: string
  portal: string
}

let applyWorker: Worker<ApplyJobData> | undefined
let recoveredDispatchCursor: string | null = null
let dispatcherTimer: ReturnType<typeof setInterval> | undefined
let connection: Redis | undefined
let queue: Queue<ApplyJobData> | undefined

function redis(): Redis {
  if (!hasRedis || !env.REDIS_URL) throw serviceUnavailable('REDIS_URL is required for approved applications.')
  connection ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  return connection
}

export function assertApplicationQueueConfigured(): void {
  if (!hasRedis || !env.REDIS_URL) {
    throw serviceUnavailable('REDIS_URL is required before approving application batches.')
  }
}

function applicationQueue(): Queue<ApplyJobData> {
  queue ??= new Queue<ApplyJobData>(QUEUE_NAME, { connection: redis() })
  return queue
}

function roundRobin<T extends { portal: string }>(values: T[]): T[] {
  const groups = new Map<string, T[]>()
  for (const value of values) {
    const group = groups.get(value.portal)
    if (group) group.push(value)
    else groups.set(value.portal, [value])
  }
  const ordered: T[] = []
  while (ordered.length < values.length) {
    for (const group of groups.values()) {
      const next = group.shift()
      if (next) ordered.push(next)
    }
  }
  return ordered
}

function applyPortalCaps<T extends { portal: string }>(values: T[]): T[] {
  const counts = new Map<string, number>()
  return values.filter((value) => {
    const count = counts.get(value.portal) ?? 0
    const cap = PORTAL_CAPS[value.portal] ?? DEFAULT_PORTAL_CAP
    if (count >= cap) return false
    counts.set(value.portal, count + 1)
    return true
  })
}

export function planApplicationOrder<T extends { portal: string }>(values: T[], target: number): T[] {
  return roundRobin(applyPortalCaps(values)).slice(0, Math.min(target, MAX_DAILY_APPLICATIONS))
}

/** Whether this candidate's application needs the user's signed-in profile. */
async function candidateNeedsProfile(candidateId: string): Promise<boolean> {
  const [row] = await db.select({ applyUrl: jobs.applyUrl, canonicalUrl: jobs.canonicalUrl, sourceApplyUrl: sql<string | null>`(select js.apply_url from job_sources js where js.job_id = ${jobs.id} order by js.fetched_at desc limit 1)` })
    .from(huntCandidates).innerJoin(jobs, eq(jobs.id, huntCandidates.jobId)).where(eq(huntCandidates.id, candidateId)).limit(1)
  if (!row) return false
  return requiresSignedInProfile([row.applyUrl, row.canonicalUrl, row.sourceApplyUrl].filter((url): url is string => Boolean(url)))
}

/**
 * Lanes for one application. Anonymous ATS forms run in throwaway contexts,
 * so a user may have several at once; account portals share the one signed-in
 * profile, so they take its lane (and a per-portal lane) as before.
 */
async function acquireApplicationLanes(data: ApplyJobData, onLost: () => void): Promise<{ release: () => Promise<void>; holdsProfileLane: boolean } | null> {
  const needsProfile = await candidateNeedsProfile(data.candidateId)
  const [[schedule], [session]] = await Promise.all([
    db.select().from(userSchedules).where(eq(userSchedules.userId, data.userId)).limit(1),
    needsProfile ? db.select().from(userBrowserSessions).where(eq(userBrowserSessions.userId, data.userId)).limit(1) : Promise.resolve([]),
  ])
  const limit = effectiveConcurrency(schedule?.applyConcurrency ?? env.APPLY_USER_CONCURRENCY, needsProfile)
  let userRelease: (() => Promise<void>) | null = null
  for (let slot = 0; slot < limit && !userRelease; slot++) userRelease = await acquireLane(`huntly:apply-user:${data.userId}:${slot}`, onLost)
  if (!userRelease) return null
  const profileRelease = needsProfile && session ? await acquireLane(profileLaneKey(session.vmId, session.tenantIndex), onLost) : async () => {}
  if (!profileRelease) { await userRelease(); return null }
  const portalRelease = needsProfile ? await acquireLane(`huntly:apply-lock:${data.userId}:${data.portal}`, onLost) : async () => {}
  if (!portalRelease) { await profileRelease(); await userRelease(); return null }
  return { release: async () => { await portalRelease(); await profileRelease(); await userRelease() }, holdsProfileLane: Boolean(needsProfile && session) }
}

const RUNNER_KEY_PREFIX = `huntly:runner:${QUEUE_NAME}:`
let heartbeatTimer: ReturnType<typeof setInterval> | undefined

/** What this runner is: version, driver, mode. The API refuses to call a runner "ready" without it. */
function runnerIdentity() {
  return {
    version: runnerVersion(),
    driver: env.APPLY_DRIVER,
    dryRun: env.APPLY_DRY_RUN,
    browserProvider: env.BROWSER_PROVIDER,
    anonBrowser: env.APPLY_ANON_BROWSER,
    concurrency: env.RUNNER_APPLY_CONCURRENCY,
    host: os.hostname(),
    pid: process.pid,
    at: new Date().toISOString(),
  }
}

export async function runnerHeartbeats(): Promise<Array<ReturnType<typeof runnerIdentity>>> {
  const keys = await withDeadline(redis().keys(`${RUNNER_KEY_PREFIX}*`), 3_000)
  if (!keys.length) return []
  const values = await withDeadline(redis().mget(keys), 3_000)
  return values.flatMap((value) => { try { return value ? [JSON.parse(value) as ReturnType<typeof runnerIdentity>] : [] } catch { return [] } })
}

export async function applicationQueueHealth() {
  const empty = { redisAvailable: false, workerConnected: false, paused: false, dryRun: env.APPLY_DRY_RUN, runners: [] as Array<ReturnType<typeof runnerIdentity>>, runnerReady: false, versionMismatch: false }
  if (!hasRedis) return empty
  try {
    const q = applicationQueue()
    const [workers, paused, runners] = await withDeadline(Promise.all([q.getWorkersCount(), q.isPaused(), runnerHeartbeats()]),3_000)
    const apiVersion = runnerVersion()
    // A connected BullMQ worker is not a ready runner: require a fresh heartbeat.
    const versionMismatch = runners.some((runner) => runner.version !== apiVersion && apiVersion !== 'dev' && runner.version !== 'dev')
    // The runner's mode wins over the API's own config: it is the process that clicks.
    return { redisAvailable: true, workerConnected: workers > 0, paused, dryRun: runners[0]?.dryRun ?? env.APPLY_DRY_RUN, runners, runnerReady: runners.length > 0, versionMismatch }
  } catch { return empty }
}

/**
 * Publish durable intents to the queue.
 *
 * Fair: each user has at most APPLY_DISPATCH_WINDOW_PER_USER jobs in Redis at
 * once and users are served round-robin, so one large batch no longer blocks
 * everyone queued behind it. Retries wait for their `not_before`. Retrying a
 * failed publish cannot duplicate a job: ids are deterministic.
 */
export async function dispatchPendingApplications(): Promise<number> {
  const runnable = and(eq(applicationDispatches.queueName,QUEUE_NAME),isNull(applicationDispatches.cancelledAt), sql`exists (select 1 from ${huntCandidates} c where c.id = ${applicationDispatches.candidateId} and c.status = 'queued')`, sql`not exists (select 1 from ${applyAttempts} a where a.candidate_id = ${applicationDispatches.candidateId} and a.created_at >= ${applicationDispatches.createdAt})`)
  const due = sql`(${applicationDispatches.notBefore} is null or ${applicationDispatches.notBefore} <= now())`
  const pending = await db.select().from(applicationDispatches).where(and(runnable, due, isNull(applicationDispatches.deliveredAt))).orderBy(applicationDispatches.createdAt).limit(500)
  const inflightRows = await db.select({ userId: applicationDispatches.userId, value: count() }).from(applicationDispatches)
    .where(and(eq(applicationDispatches.queueName, QUEUE_NAME), isNull(applicationDispatches.cancelledAt), isNotNull(applicationDispatches.deliveredAt),
      sql`exists (select 1 from ${huntCandidates} c where c.id = ${applicationDispatches.candidateId} and c.status in ('queued','applying'))`))
    .groupBy(applicationDispatches.userId)
  const inflight = new Map(inflightRows.map((row) => [row.userId, Number(row.value)]))
  const byUser = new Map<string, typeof pending>()
  for (const row of pending) {
    const list = byUser.get(row.userId)
    if (list) list.push(row)
    else byUser.set(row.userId, [row])
  }
  const fresh: typeof pending = []
  for (let added = true; added;) {
    added = false
    for (const [userId, rows] of byUser) {
      if ((inflight.get(userId) ?? 0) >= env.APPLY_DISPATCH_WINDOW_PER_USER || !rows.length) continue
      fresh.push(rows.shift()!)
      inflight.set(userId, (inflight.get(userId) ?? 0) + 1)
      added = true
    }
  }
  const recovery = await db.select().from(applicationDispatches).where(and(runnable,isNotNull(applicationDispatches.deliveredAt), recoveredDispatchCursor ? sql`${applicationDispatches.id} > ${recoveredDispatchCursor}::uuid` : undefined)).orderBy(applicationDispatches.id).limit(200)
  recoveredDispatchCursor = recovery.length === 200 ? recovery[recovery.length-1]!.id : null
  for (const row of [...fresh, ...recovery]) {
    if (row.deliveredAt && await applicationQueue().getJob(`dispatch-${row.id}`)) continue
    await applicationQueue().add('apply-approved-candidate', { userId: row.userId, runId: row.runId, candidateId: row.candidateId, portal: row.portal, dispatchId: row.id }, {
      jobId: `dispatch-${row.id}`, attempts: 1, removeOnComplete: { age: 7 * 86_400 }, removeOnFail: { age: 30 * 86_400 },
    })
    await db.update(applicationDispatches).set({ deliveredAt: new Date(), updatedAt: new Date() }).where(eq(applicationDispatches.id, row.id))
  }
  return fresh.length + recovery.length
}

export async function enqueueApprovedCandidates(
  userId: string,
  runId: string,
  selectedIds: string[],
): Promise<{ queued: number; capped: boolean; queuedJobIds: string[]; skipped: Array<{ jobId: string; reason: string }> }> {
  const result = await db.transaction(async tx => {
  await assertApprovalLease()
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`application-budget:${userId}`}, 0))`)
  const [[run], selectedRows] = await Promise.all([
    tx.select({ target: huntRuns.targetApplications })
      .from(huntRuns)
      .where(and(eq(huntRuns.id, runId), eq(huntRuns.userId, userId)))
      .limit(1),
    tx.select({ id: huntCandidates.id, jobId: huntCandidates.jobId, portal: huntCandidates.sourcePortal, score: huntCandidates.score, title: jobs.title, company: jobs.company, jobUrl: jobs.canonicalUrl, description: jobs.descriptionText, locations: jobs.locations, applyUrl: sql<string>`coalesce(nullif(${jobs.applyUrl}, ''), (select nullif(js.apply_url, '') from job_sources js where js.job_id = ${jobs.id} and js.portal_id = ${huntCandidates.sourcePortal} order by js.fetched_at desc limit 1), ${jobs.canonicalUrl})` })
      .from(huntCandidates)
      .innerJoin(jobs, eq(huntCandidates.jobId, jobs.id))
      .where(and(
        eq(huntCandidates.userId, userId),
        eq(huntCandidates.runId, runId),
        inArray(huntCandidates.id, selectedIds),
        inArray(huntCandidates.status, ['discovered','rejected','approved']),
        sql`not exists (select 1 from ${applications} a where a.user_id = ${userId} and a.job_id = ${huntCandidates.jobId})`,
      )),
  ])
  if (!run) throw serviceUnavailable('Hunt run disappeared before queueing.')
  const [used] = await tx.select({ value: count() }).from(applications).where(and(eq(applications.userId, userId), gte(applications.queuedAt, dailyBudget(0).start), sql`not (${applications.status} = 'closed' and ${applications.notes} is not distinct from 'Cancelled before application started.')`))
  const [spec] = await tx.select({target:huntSpecs.dailyTarget}).from(huntSpecs).where(eq(huntSpecs.userId,userId)).limit(1)
  const target = Math.min(Math.max(0, run.target), dailyBudget(used?.value ?? 0,spec?.target??100).remaining)
  const order = new Map(selectedIds.map((id, index) => [id, index]))
  const selected = selectedRows.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
  const unavailable = selected.filter(row => isAggregatorApplicationUrl(row.applyUrl))
  const skipped = unavailable.map(row => ({ jobId: row.jobId, reason: 'No direct application URL found. Open the source to apply manually.' }))
  if (unavailable.length) {
    await tx.update(huntCandidates).set({ status: 'needs_review', updatedAt: new Date() }).where(inArray(huntCandidates.id, unavailable.map(r => r.id)))
    await tx.update(huntRunJobs).set({ status: 'needs_review', reasons: sql`array_append(${huntRunJobs.reasons}, 'no_applyable_url')`, updatedAt: new Date() }).where(and(eq(huntRunJobs.runId, runId), inArray(huntRunJobs.jobId, unavailable.map(r => r.jobId))))
  }
  const applyable = selected.filter(row => !isAggregatorApplicationUrl(row.applyUrl))
  const ordered = planApplicationOrder(applyable, target)
  if (ordered.length === 0) {
    await tx.update(huntCandidates).set({ status: 'discovered', updatedAt: new Date() }).where(and(eq(huntCandidates.userId, userId), inArray(huntCandidates.id, selectedIds), eq(huntCandidates.status, 'approved')))
    return { queued: 0, capped: applyable.length > 0, queuedJobIds: [], skipped }
  }

  // Make queued applications visible immediately. The worker will reuse these
  // rows and transition them as it prepares each browser session.
  await tx.insert(applications).values(ordered.map((candidate) => ({
    userId,
    jobId: candidate.jobId,
    role: candidate.title,
    company: candidate.company,
    location: (candidate.locations as Array<{ raw?: string }>).map((item) => item.raw).filter(Boolean).join('; '),
    jobUrl: candidate.jobUrl,
    jobDescription: candidate.description,
    portalId: candidate.portal,
    portalName: candidate.portal,
    matchScore: candidate.score,
    status: 'queued' as const,
    huntRunId: runId,
  }))).onConflictDoNothing()

  await tx.insert(applicationDispatches).values(ordered.map(candidate => ({ userId, runId, candidateId: candidate.id, portal: candidate.portal, queueName:QUEUE_NAME })))
  const appRows = await tx.select({ id: applications.id }).from(applications).where(and(eq(applications.userId, userId), inArray(applications.jobId, ordered.map(c => c.jobId))))
  await tx.insert(applicationEvents).values(appRows.map(app => ({ applicationId: app.id, toStatus: 'queued' as const, note: 'Queued for immediate application; starts when your browser lane is free.' })))

  await tx
    .update(huntCandidates)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(inArray(huntCandidates.id, ordered.map((candidate) => candidate.id)))
  await tx
    .update(huntRunJobs)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(and(
      eq(huntRunJobs.runId, runId),
      inArray(huntRunJobs.jobId, ordered.map((candidate) => candidate.jobId)),
    ))
  await tx
    .update(huntCandidates)
    .set({ status: 'discovered', updatedAt: new Date() })
    .where(and(
      inArray(huntCandidates.id, applyable.map((candidate) => candidate.id)),
      notInArray(huntCandidates.id, ordered.map((candidate) => candidate.id)),
    ))
  const rejectedJobIds = applyable
    .filter((candidate) => !ordered.some((queued) => queued.id === candidate.id))
    .map((candidate) => candidate.jobId)
  if (rejectedJobIds.length > 0) {
    await tx
      .update(huntRunJobs)
      .set({ status: sql`coalesce(${huntRunJobs.eligibilityStatus}, 'eligible')::hunt_run_job_status`, updatedAt: new Date() })
      .where(and(eq(huntRunJobs.runId, runId), inArray(huntRunJobs.jobId, rejectedJobIds)))
  }
  await tx
    .update(huntRuns)
    .set({
      status: 'applying',
      candidatesApproved: ordered.length,
      approvedAt: new Date(),
      progress: { stage: 'apply', queued: ordered.length, target },
      updatedAt: new Date(),
    })
    .where(and(eq(huntRuns.id, runId), eq(huntRuns.userId, userId)))

  await assertApprovalLease()
  return { queued: ordered.length, capped: applyable.length > ordered.length, queuedJobIds: ordered.map(r => r.jobId), skipped }
  })
  await withDeadline(dispatchPendingApplications(),5_000).catch(error => logger.error({ err: error }, 'application dispatch deferred; durable intent retained for runner recovery'))
  return result
}

async function finishRunWhenSettled(job: BullJob<ApplyJobData>): Promise<void> {
  const [active] = await db
    .select({ value: count() })
    .from(huntCandidates)
    .where(and(
      eq(huntCandidates.runId, job.data.runId),
      inArray(huntCandidates.status, ['approved', 'tailored', 'queued', 'applying']),
    ))
  if ((active?.value ?? 0) > 0) return
  await db
    .update(huntRuns)
    .set({ status: 'completed', finishedAt: new Date(), progress: { stage: 'completed' }, updatedAt: new Date() })
    .where(eq(huntRuns.id, job.data.runId))
}

/** Stop the browser an interrupted attempt left behind. Ephemeral contexts died with their runner. */
async function stopInterruptedVm(userId: string, browserSessionId: string): Promise<void> {
  if (browserSessionId.startsWith('ephemeral:')) return
  const vm = /^vm:(\d+)$/.exec(browserSessionId)
  if (!vm) { await stopBrowser(browserSessionId); return }
  const [owned] = await db.select().from(userBrowserSessions).where(and(eq(userBrowserSessions.userId, userId), eq(userBrowserSessions.tenantIndex, Number(vm[1])))).limit(1)
  if (!owned) return
  await withBrowserLifecycle(userId, async () => {
    if (await redis().exists(profileLaneKey(owned.vmId, owned.tenantIndex))) return
    if ((await getTenantStatus(owned.tenantIndex)).mode === 'apply') await stopTenant(owned.tenantIndex)
  })
}

/**
 * A queue job can disappear after its database writes have begun — for
 * example when the browser runner is killed between creating an attempt and
 * opening a session. Discovery already has this recovery path; application
 * work needs the same one or the dashboard can report "applying" forever.
 */
export async function reconcileInterruptedApplications(): Promise<number> {
  await dispatchPendingApplications()
  const cutoff = new Date(Date.now() - INTERRUPTED_AFTER_MS)
  const jobs = await applicationQueue().getJobs(['active', 'waiting', 'delayed'])
  const living = await Promise.all(jobs.map(async job => {
    const state = await job.getState()
    if (state === 'active' && (await redis().pttl(applicationQueue().toKey(`${job.id}:lock`))) <= 0) return null
    return `${job.data.runId}:${job.data.candidateId}`
  }))
  const liveJobs = new Set(living.filter(Boolean))
  const stale = await db
    .select({
      candidateId: huntCandidates.id,
      userId: huntCandidates.userId,
      runId: huntCandidates.runId,
      jobId: huntCandidates.jobId,
      candidateStatus: huntCandidates.status,
      attemptId: applyAttempts.id,
      browserSessionId: applyAttempts.browserSessionId,
      submitStartedAt: applyAttempts.submitStartedAt,
      portal: huntCandidates.sourcePortal,
    })
    .from(huntCandidates)
    .innerJoin(huntRuns, eq(huntRuns.id, huntCandidates.runId))
    .leftJoin(
      applyAttempts,
      and(
        eq(applyAttempts.candidateId, huntCandidates.id),
        inArray(applyAttempts.status, ['pending', 'submitting']),
      ),
    )
    .where(and(
      eq(huntRuns.status, 'applying'),
      inArray(huntCandidates.status, ['queued', 'applying']),
      lt(huntCandidates.updatedAt, cutoff),
      QUEUE_NAME === 'hunt-apply'
        ? sql`(not exists (select 1 from ${applicationDispatches} d where d.candidate_id=${huntCandidates.id}) or exists (select 1 from ${applicationDispatches} d where d.candidate_id=${huntCandidates.id} and d.queue_name=${QUEUE_NAME}))`
        : sql`exists (select 1 from ${applicationDispatches} d where d.candidate_id=${huntCandidates.id} and d.queue_name=${QUEUE_NAME})`,
    ))

  const repairedRuns = new Set<string>()
  let repaired = 0
  for (const row of stale) {
    if (liveJobs.has(`${row.runId}:${row.candidateId}`)) continue

    // Interrupted before any submit click (runner killed, VM restarted): requeue
    // with backoff instead of parking it for a human, within the retry budget.
    // Only an attempt that was still pending when its worker vanished. A
    // candidate whose attempt finished is never requeued from here: that
    // turned a missed final write into a replanning loop.
    if (env.APPLY_AUTO_RETRY && row.attemptId && !row.submitStartedAt && await previousTransientRetries(row.candidateId) < MAX_TRANSIENT_RETRIES) {
      const retries = await previousTransientRetries(row.candidateId)
      const requeued = await db.transaction(async (tx) => {
        const [candidate] = await tx.update(huntCandidates).set({ status: 'queued', updatedAt: new Date() })
          .where(and(eq(huntCandidates.id, row.candidateId), inArray(huntCandidates.status, ['queued', 'applying']))).returning({ id: huntCandidates.id })
        if (!candidate) return false
        if (row.attemptId) await tx.update(applyAttempts).set({ status: 'failed', failureClass: 'transient', error: 'Application worker stopped before this attempt completed; retrying automatically.', completedAt: new Date(), updatedAt: new Date() }).where(and(eq(applyAttempts.id, row.attemptId), isNull(applyAttempts.completedAt)))
        await tx.update(applicationDispatches).set({ cancelledAt: new Date(), updatedAt: new Date() }).where(and(eq(applicationDispatches.candidateId, row.candidateId), isNull(applicationDispatches.cancelledAt)))
        await tx.insert(applicationDispatches).values({ userId: row.userId, runId: row.runId, candidateId: row.candidateId, portal: row.portal, queueName: QUEUE_NAME, notBefore: new Date(Date.now() + retryDelayMs(retries)) })
        return true
      })
      if (requeued) {
        if (row.browserSessionId?.startsWith('vm:')) await stopInterruptedVm(row.userId, row.browserSessionId).catch(() => undefined)
        logger.warn({ candidateId: row.candidateId, retries }, 'requeued an interrupted pre-submit application')
        repaired += 1
        continue
      }
    }

    const [updatedCandidate] = await db
      .update(huntCandidates)
      .set({ status: 'needs_review', updatedAt: new Date() })
      .where(and(
        eq(huntCandidates.id, row.candidateId),
        inArray(huntCandidates.status, ['queued', 'applying']),
      ))
      .returning({ id: huntCandidates.id })
    if (!updatedCandidate) continue

    if (row.attemptId) {
      await db
        .update(applyAttempts)
        .set({
          // Only a fenced attempt may hide a click; an unfenced one provably never submitted.
          status: row.submitStartedAt ? 'unknown' : 'failed',
          failureClass: row.submitStartedAt ? 'uncertain_submit' : 'transient',
          ...(row.submitStartedAt ? { submitOutcome: 'uncertain' } : {}),
          error: 'Application worker stopped before this attempt completed.',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(applyAttempts.id, row.attemptId))
    }
    if (row.browserSessionId) {
      await stopInterruptedVm(row.userId, row.browserSessionId).catch((error: unknown) => {
        logger.warn({ err: error, sessionId: row.browserSessionId }, 'could not stop an interrupted browser session')
      })
    }
    await db
      .update(applications)
      .set({ status: 'needs_review', updatedAt: new Date() })
      .where(and(
        eq(applications.userId, row.userId),
        eq(applications.jobId, row.jobId),
        eq(applications.status, 'queued'),
      ))
    await db
      .update(huntRunJobs)
      .set({ status: 'needs_review', updatedAt: new Date() })
      .where(and(eq(huntRunJobs.runId, row.runId), eq(huntRunJobs.jobId, row.jobId)))
    await db
      .update(huntRuns)
      .set({
        applicationsNeedsReview: sql`${huntRuns.applicationsNeedsReview} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(huntRuns.id, row.runId))

    repairedRuns.add(row.runId)
    repaired += 1
    logger.warn({ runId: row.runId, candidateId: row.candidateId, candidateStatus: row.candidateStatus }, 'repaired an interrupted application')
  }

  for (const runId of repairedRuns) {
    const [active] = await db
      .select({ value: count() })
      .from(huntCandidates)
      .where(and(
        eq(huntCandidates.runId, runId),
        inArray(huntCandidates.status, ['approved', 'tailored', 'queued', 'applying']),
      ))
    if ((active?.value ?? 0) === 0) {
      await db
        .update(huntRuns)
        .set({
          status: 'failed',
          error: 'Application worker stopped before this hunt finished. Review the interrupted applications before retrying.',
          finishedAt: new Date(),
          progress: { stage: 'failed', reason: 'application_worker_interrupted' },
          updatedAt: new Date(),
        })
        .where(and(eq(huntRuns.id, runId), eq(huntRuns.status, 'applying')))
    }
  }

  return repaired
}

async function handleFailedApplicationJob(job: BullJob<ApplyJobData>, error: Error): Promise<void> {
  const [candidate] = await db
    .select({ id: huntCandidates.id, runId: huntCandidates.runId, userId: huntCandidates.userId, jobId: huntCandidates.jobId })
    .from(huntCandidates)
    .where(and(eq(huntCandidates.id, job.data.candidateId), eq(huntCandidates.userId, job.data.userId)))
    .limit(1)
  if (candidate) {
    await db
      .update(applyAttempts)
      .set({
        // `submitting` means the fence was written: that click may have landed.
        status: sql`case when ${applyAttempts.submitStartedAt} is null then 'failed'::apply_attempt_status else 'unknown'::apply_attempt_status end`,
        failureClass: sql`case when ${applyAttempts.submitStartedAt} is null then ${classifyError(error, { submitAttempted: false })} else 'uncertain_submit' end`,
        error: `Application job failed before completion: ${error.message}`,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(applyAttempts.candidateId, candidate.id),
        inArray(applyAttempts.status, ['pending', 'submitting']),
        isNull(applyAttempts.completedAt),
      ))
    const [updated] = await db
      .update(huntCandidates)
      .set({ status: 'needs_review', updatedAt: new Date() })
      .where(and(eq(huntCandidates.id, candidate.id), inArray(huntCandidates.status, ['queued', 'applying'])))
      .returning({ id: huntCandidates.id })
    if (updated) {
      await db
        .update(applications)
        .set({ status: 'needs_review', updatedAt: new Date() })
        .where(and(
          eq(applications.userId, candidate.userId),
          eq(applications.jobId, candidate.jobId),
          eq(applications.status, 'queued'),
        ))
      await db
        .update(huntRunJobs)
        .set({ status: 'needs_review', updatedAt: new Date() })
        .where(and(eq(huntRunJobs.runId, candidate.runId), eq(huntRunJobs.jobId, candidate.jobId)))
      await db
        .update(huntRuns)
        .set({ applicationsNeedsReview: sql`${huntRuns.applicationsNeedsReview} + 1`, updatedAt: new Date() })
        .where(eq(huntRuns.id, candidate.runId))
    }
  }
  await finishRunWhenSettled(job)
  logger.error({ err: error, jobId: job.id, candidateId: job.data.candidateId }, 'application job failed')
}

export function startApplicationWorker(): Worker<ApplyJobData> {
  const worker = new Worker<ApplyJobData>(
    QUEUE_NAME,
    async (job, token) => {
      const [flag] = await db.select({ id: attemptFlags.id }).from(attemptFlags).where(and(eq(attemptFlags.userId, job.data.userId), eq(attemptFlags.status, 'open'))).limit(1)
      const [candidate] = await db.select().from(huntCandidates).where(and(eq(huntCandidates.id, job.data.candidateId), eq(huntCandidates.userId, job.data.userId))).limit(1)
      if (!candidate || !['queued', 'tailored'].includes(candidate.status)) return
      const controller = new AbortController()
      const lanes = flag ? null : await acquireApplicationLanes(job.data, () => controller.abort(new Error('Application lease lost')))
      if (!lanes) {
        await job.moveToDelayed(Date.now() + 10_000, token)
        throw new DelayedError()
      }
      try {
        // Atomic DB claim fences a late outbox publish against cancellation.
        // A cancelled/obsolete dispatch can never start a newly retried candidate.
        const [claimed] = await db.update(huntCandidates).set({status:'applying',updatedAt:new Date()})
          .where(and(eq(huntCandidates.id,job.data.candidateId),eq(huntCandidates.userId,job.data.userId),inArray(huntCandidates.status,['queued','tailored']),
            job.data.dispatchId
              ? sql`exists (select 1 from ${applicationDispatches} d where d.id = ${job.data.dispatchId} and d.cancelled_at is null)`
              : sql`not exists (select 1 from ${applicationDispatches} d where d.candidate_id = ${job.data.candidateId})`,
          )).returning({id:huntCandidates.id})
        if (!claimed) return
        await applyApprovedCandidate(job.data.userId, job.data.candidateId, { signal: controller.signal, holdsProfileLane: lanes.holdsProfileLane })
      } catch (error) {
        if (error instanceof ApplicationDeferredError) { await job.moveToDelayed(Date.now() + 30_000, token); throw new DelayedError() }
        throw error
      } finally {
        await lanes.release()
        // Top the user's window up immediately rather than waiting for the sweep.
        void dispatchPendingApplications().catch((error: unknown) => logger.warn({ err: error }, 'post-job dispatch deferred to the sweep'))
      }
      await finishRunWhenSettled(job)
    },
    {
      connection: redis(),
      concurrency: env.RUNNER_APPLY_CONCURRENCY,

      // Hosted browser sessions can spend several minutes opening a portal,
      // filling a form and waiting for a human takeover. The queue lock must
      // cover that window or BullMQ will mark a healthy browser job stalled.
      lockDuration: 15 * 60_000,
      maxStalledCount: 0,
    },
  )
  worker.on('failed', (job, error) => {
    if (job) void handleFailedApplicationJob(job, error).catch((recoveryError: unknown) => {
      logger.error({ err: recoveryError, jobId: job.id, candidateId: job.data.candidateId }, 'could not reconcile a failed application job')
    })
  })
  applyWorker = worker
  const beat = () => { void redis().set(`${RUNNER_KEY_PREFIX}${os.hostname()}:${process.pid}`, JSON.stringify(runnerIdentity()), 'EX', 60).catch((error: unknown) => logger.warn({ err: error }, 'runner heartbeat failed')) }
  beat()
  heartbeatTimer = setInterval(beat, 15_000)
  heartbeatTimer.unref()
  let sweeping = false
  const sweep = async () => {
    if (sweeping) return
    sweeping = true
    try { await reconcileInterruptedApplications() } catch(error) { logger.error({err:error},'application recovery sweep failed') } finally { sweeping = false }
  }
  dispatcherTimer = setInterval(() => { void sweep() }, 15_000)
  dispatcherTimer.unref()
  void sweep()
  return worker
}

export async function closeApplicationQueue(): Promise<void> {
  if (dispatcherTimer) clearInterval(dispatcherTimer)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  await connection?.del(`${RUNNER_KEY_PREFIX}${os.hostname()}:${process.pid}`).catch(() => undefined)
  if (applyWorker) await applyWorker.close()
  applyWorker = undefined
  if (queue) await queue.close()
  queue = undefined
  if (connection) await connection.quit()
  connection = undefined
}

/** Read-only queue diagnostics. Never promotes, retries, or removes a job. */
export async function applicationJobInfo(userId: string, candidateId: string, runId: string) {
  if (!hasRedis) return { queueState: 'unavailable', scheduledFor: null, workerConnected: false, lockActive: false }
  try {
    const q = applicationQueue()
    const [dispatch] = await db.select().from(applicationDispatches).where(and(eq(applicationDispatches.candidateId, candidateId), eq(applicationDispatches.queueName,QUEUE_NAME), isNull(applicationDispatches.cancelledAt))).orderBy(sql`${applicationDispatches.createdAt} desc`).limit(1)
    const job = await q.getJob(dispatch ? `dispatch-${dispatch.id}` : `apply-${userId}-${candidateId}`)
    const workerConnected = (await q.getWorkersCount()) > 0
    if (!job || job.data.userId !== userId || job.data.runId !== runId) return { queueState: 'missing', scheduledFor: null, workerConnected, lockActive: false }
    const queueState = await job.getState()
    const lockActive = queueState === 'active' && (await redis().pttl(q.toKey(`${job.id}:lock`))) > 0
    return { queueState, scheduledFor: queueState === 'delayed' ? new Date(job.timestamp + job.delay).toISOString() : null, workerConnected, lockActive }
  } catch {
    return { queueState: 'unavailable', scheduledFor: null, workerConnected: false, lockActive: false }
  }
}

/** remove() is atomic in Redis and refuses an active job, closing the start/cancel race. */
export async function removeWaitingApplication(userId: string, candidateId: string) {
  const dispatches = await db.select().from(applicationDispatches).where(and(eq(applicationDispatches.userId, userId), eq(applicationDispatches.candidateId, candidateId), eq(applicationDispatches.queueName,QUEUE_NAME), isNull(applicationDispatches.cancelledAt)))
  const ids = [`apply-${userId}-${candidateId}`, ...dispatches.map(d => `dispatch-${d.id}`)]
  for (const id of ids) {
    const job = await applicationQueue().getJob(id)
    if (!job) continue
    const state = await job.getState()
    if (!['waiting', 'delayed', 'paused', 'waiting-children', 'completed', 'failed'].includes(state)) throw conflict('This application has started. Flag it for review instead of cancelling.')
    try { await job.remove() } catch { throw conflict('This application started while you were cancelling. Flag it for review instead.') }
  }
}
