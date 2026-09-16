import { and, count, desc, eq, sql } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/client.js'
import {
  activityEvents,
  applications,
  huntCandidates,
  huntRunJobs,
  huntRuns,
  jobSources,
  jobs,
  userPortals,
} from '../../db/schema.js'
import { salaryOf, experienceOf } from './job-format.js'
import { listDashboardJobs, jobsQuerySchema } from './scraped-jobs.js'
import { approveScrapedJobs } from '../../hunt/approval.js'
import { notFound } from '../../lib/errors.js'
import { asyncHandler, ok, pathParam } from '../../lib/http.js'
import { localDate, localDateKey, todayLocal } from '../../lib/sql.js'
import { computeStreak, toRelativeLabel } from '../../lib/time.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate, validatedQuery } from '../../middleware/validate.js'

export const dashboardRouter: Router = Router()
dashboardRouter.use(requireAuth)

const querySchema = z.object({
  activityLimit: z.coerce.number().int().min(1).max(50).default(8),
  recentApplications: z.coerce.number().int().min(1).max(20).default(4),
})

const jobDetailQuerySchema = z.object({ runId: z.string().uuid() })
const jobParamSchema = z.object({ jobId: z.string().uuid() })
const bulkApplySchema = z.object({ jobs: z.array(z.object({ jobId: z.string().uuid(), runId: z.string().uuid() })).min(1).max(100) })

/**
 * Salary and experience are parsed once, at scrape time, and stored. This used
 * to run a regex over every description on every request — the same answer,
 * recomputed per page view, and unfilterable because it existed only in the
 * response.
 */


/**
 * Everything the Den screen shows, in one round trip.
 *
 * It is one endpoint rather than six because the screen renders all of it at
 * once — six requests would just mean six chances to render half a dashboard.
 * The queries fan out in parallel below.
 */
dashboardRouter.get(
  '/',
  validate({ query: querySchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const query = validatedQuery<z.infer<typeof querySchema>>(req)

    // "Today" means today in APP_TIMEZONE, not UTC — otherwise the counter
    // resets at 05:30 IST and the user watches their progress vanish.
    const appliedDayKey = localDateKey(applications.appliedAt)

    type DashboardSummary = {
      applied_today: number
      status_counts: Record<string, number>
      jobs_found: number
      portals_connected: number
      pending_referrals: number
      referrals_today: number
      daily_target: number | null
    }

    // The Den used to make nine independent database round trips. They were
    // launched together, but the pool has six connections and the database is
    // remote, so the request still took multiple network waves. Keep the two
    // lists separate, but fold all counters into one database call.
    const [summaryRows, activeDays, recentApplications, activity] = await Promise.all([
      db.execute(
        sql<DashboardSummary>`
          select
            coalesce((
              select count(*)::int
              from ${applications}
              where ${applications.userId} = ${auth.id}
                and ${localDate(applications.appliedAt)} = ${todayLocal()}
            ), 0)::int as applied_today,
            coalesce((
              select json_object_agg(status, value)
              from (
                select ${applications.status} as status, count(*)::int as value
                from ${applications}
                where ${applications.userId} = ${auth.id}
                group by ${applications.status}
              ) as status_counts
            ), '{}'::json)::json as status_counts,
            coalesce((
              select sum(${userPortals.jobsFound})::int
              from ${userPortals}
              where ${userPortals.userId} = ${auth.id}
                and ${userPortals.connected} = true
            ), 0)::int as jobs_found,
            (
              select count(*)::int
              from ${userPortals}
              where ${userPortals.userId} = ${auth.id}
                and ${userPortals.connected} = true
            ) as portals_connected,
            (
              select count(*)::int
              from referrals
              where user_id = ${auth.id}
                and handled = false
            ) as pending_referrals,
            (
              select count(*)::int
              from referrals
              where user_id = ${auth.id}
                and ${localDate(sql.raw('referrals.received_at'))} = ${todayLocal()}
            ) as referrals_today,
            (
              select daily_target
              from hunt_specs
              where user_id = ${auth.id}
              limit 1
            ) as daily_target
        `,
      ),
      // Distinct days with at least one application — the streak input.
      db
        .selectDistinct({
          day: appliedDayKey,
        })
        .from(applications)
        .where(and(eq(applications.userId, auth.id), sql`${applications.appliedAt} is not null`))
        .orderBy(desc(appliedDayKey))
        .limit(400),

      db
        .select()
        .from(applications)
        .where(eq(applications.userId, auth.id))
        .orderBy(desc(sql`coalesce(${applications.appliedAt}, ${applications.queuedAt})`))
        .limit(query.recentApplications),

      db
        .select()
        .from(activityEvents)
        .where(eq(activityEvents.userId, auth.id))
        .orderBy(desc(activityEvents.createdAt))
        .limit(query.activityLimit),
    ])

    const summary = summaryRows.rows[0] as DashboardSummary | undefined

    const counts: Record<string, number> = {
      queued: 0,
      applied: 0,
      viewed: 0,
      interview: 0,
      rejected: 0,
    }
    for (const [status, value] of Object.entries(summary?.status_counts ?? {})) {
      counts[status] = Number(value)
    }

    const totalApplications = Object.values(counts).reduce((a, b) => a + b, 0)
    const appliedToday = Number(summary?.applied_today ?? 0)
    const dailyTarget = Number(summary?.daily_target ?? 50)

    const now = new Date()

    ok(res, {
      hunter: {
        name: auth.name,
        avatar: auth.avatar,
        // The user's own headline lives on the kit; the Den only needs a name.
        streakDays: computeStreak(
          activeDays.map((row) => row.day),
          now,
        ),
        dailyTarget,
        appliedToday,
        remainingToday: Math.max(0, dailyTarget - appliedToday),
      },
      stats: {
        appliedToday,
        totalApplications,
        jobsScraped: Number(summary?.jobs_found ?? 0),
        portalsConnected: Number(summary?.portals_connected ?? 0),
        interviews: counts.interview ?? 0,
        viewed: counts.viewed ?? 0,
        queued: counts.queued ?? 0,
        rejected: counts.rejected ?? 0,
        referralsWaiting: Number(summary?.pending_referrals ?? 0),
        referralsToday: Number(summary?.referrals_today ?? 0),
      },
      recentApplications: recentApplications.map((row) => ({
        id: row.id,
        role: row.role,
        company: row.company,
        logo: row.logo,
        location: row.location ?? '',
        matchScore: row.matchScore ?? 0,
        status: row.status,
        appliedAt:
          row.status === 'queued'
            ? 'in queue'
            : toRelativeLabel(row.appliedAt ?? row.createdAt, now),
      })),
      // "Hunty's trail" — matches the `activity` export in the UI's mock data.
      activity: activity.map((row) => ({
        id: row.id,
        emoji: row.emoji,
        text: row.text,
        time: toRelativeLabel(row.createdAt, now),
        at: row.createdAt.toISOString(),
        kind: row.kind,
        meta: row.meta,
      })),
    })
  }),
)

/** The feed on its own, for a "load more" on the Den screen. */
dashboardRouter.get(
  '/activity',
  validate({
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const { limit, offset } = validatedQuery<{ limit: number; offset: number }>(req)

    const [rows, [totalRow]] = await Promise.all([
      db
        .select()
        .from(activityEvents)
        .where(eq(activityEvents.userId, auth.id))
        .orderBy(desc(activityEvents.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(activityEvents).where(eq(activityEvents.userId, auth.id)),
    ])

    const now = new Date()
    ok(
      res,
      rows.map((row) => ({
        id: row.id,
        emoji: row.emoji,
        text: row.text,
        time: toRelativeLabel(row.createdAt, now),
        at: row.createdAt.toISOString(),
        kind: row.kind,
        meta: row.meta,
      })),
      { total: totalRow?.value ?? 0, limit, offset },
    )
  }),
)

dashboardRouter.get('/jobs', validate({ query: jobsQuerySchema }), asyncHandler(async (req, res) => {
  ok(res, await listDashboardJobs(currentUser(req).id, validatedQuery<z.infer<typeof jobsQuerySchema>>(req)))
}))

dashboardRouter.post('/jobs/apply', validate({ body: bulkApplySchema }), asyncHandler(async (req, res) => {
  ok(res, await approveScrapedJobs(currentUser(req).id, (req.body as z.infer<typeof bulkApplySchema>).jobs))
}))

dashboardRouter.get(
  '/jobs/:jobId',
  validate({ params: jobParamSchema, query: jobDetailQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const query = validatedQuery<z.infer<typeof jobDetailQuerySchema>>(req)
    const jobId = pathParam(req, 'jobId')

    // One round trip instead of five. The run, the job, this user's row for it,
    // the candidate and the source it came from are all reachable by join, and
    // the old sequential version paid full network latency for each.
    const [row] = await db
      .select({
        run: huntRuns,
        job: jobs,
        runJob: huntRunJobs,
        candidate: huntCandidates,
        source: jobSources,
      })
      .from(huntRuns)
      .innerJoin(jobs, eq(jobs.id, jobId))
      .leftJoin(
        huntRunJobs,
        and(
          eq(huntRunJobs.runId, huntRuns.id),
          eq(huntRunJobs.jobId, jobs.id),
          eq(huntRunJobs.userId, auth.id),
        ),
      )
      .leftJoin(
        huntCandidates,
        and(eq(huntCandidates.runId, huntRuns.id), eq(huntCandidates.jobId, jobs.id)),
      )
      .leftJoin(jobSources, eq(jobSources.jobId, jobs.id))
      .where(and(eq(huntRuns.id, query.runId), eq(huntRuns.userId, auth.id)))
      // Prefer the source row for the portal this run used, then the newest.
      .orderBy(
        desc(sql`(${jobSources.portalId} is not distinct from ${huntRunJobs.sourcePortal})`),
        desc(jobSources.fetchedAt),
      )
      .limit(1)

    if (!row) throw notFound('Hunt run not found')
    const { run, job, runJob, candidate, source } = row
    if (!runJob) throw notFound('Job was not found in this hunt run')

    ok(res, {
      runId: run.id,
      runStatus: run.status,
      eligibility: runJob?.eligibilityStatus ?? (candidate ? 'eligible' : runJob?.status ?? 'scraped'),
      id: runJob?.id ?? `historical:${run.id}:${job.id}`,
      jobId: job.id,
      candidateId: candidate?.id ?? null,
      title: job.title,
      company: job.company,
      locations: job.locations,
      remote: job.remoteMode,
      employmentType: job.employmentType,
      sourcePortal: runJob?.sourcePortal ?? source?.portalId ?? '',
      status: runJob?.status ?? 'scraped',
      candidateStatus: candidate?.status ?? null,
      score: runJob?.score ?? candidate?.score ?? null,
      scoreBreakdown: runJob?.scoreBreakdown ?? candidate?.scoreBreakdown ?? null,
      reasons: runJob?.reasons ?? candidate?.reasons ?? [],
      skills: job.skills,
      salary: salaryOf(job),
      experience: experienceOf(job),
      experienceMin: job.experienceMin,
      experienceMax: job.experienceMax,
      experienceText: job.experienceText,
      responsibilities: job.responsibilities,
      description: job.descriptionText ?? '',
      descriptionHtml: job.descriptionHtml,
      jobUrl: job.canonicalUrl,
      applyUrl: job.applyUrl ?? source?.applyUrl ?? null,
      postedAt: job.postedAt.toISOString(),
      postedAtPrecision: job.postedAtPrecision,
      discoveredAt: (runJob?.discoveredAt ?? source?.fetchedAt ?? job.createdAt).toISOString(),
    })
  }),
)
