import { and, asc, count, desc, eq, getTableColumns, gte, ilike, lte, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { applications, huntCandidates, huntRunJobs, huntRuns, jobs } from '../../db/schema.js'
import { notFound } from '../../lib/errors.js'
import { localDate } from '../../lib/sql.js'
import { experienceOf, salaryOf } from './job-format.js'
import { ACTIVE_CANDIDATE_STATUSES, AGGREGATOR_URL_PATTERN, ELIGIBILITY_STATUSES, REVIEWABLE_RUNS } from './job-policy.js'

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const jobsQuerySchema = z.object({
  runId: z.string().uuid().optional(),
  scope: z.enum(['all', 'latest']).default('latest'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().refine(v => [20, 50, 100].includes(v)).default(100),
  status: z.enum(ELIGIBILITY_STATUSES).optional(),
  portal: z.string().trim().min(1).max(80).optional(),
  query: z.string().trim().max(120).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  maxExperience: z.coerce.number().int().min(0).max(50).optional(),
  remote: z.enum(['remote', 'hybrid', 'onsite', 'unknown']).optional(),
  foundOn: isoDay.optional(), postedOn: isoDay.optional(),
  sort: z.enum(['score-desc', 'score-asc', 'newest', 'company']).default('score-desc'),
  selectableOnly: z.enum(['true', 'false']).default('false'),
}).refine(q => q.minScore === undefined || q.maxScore === undefined || q.minScore <= q.maxScore, { message: 'minScore cannot exceed maxScore' })

export async function listDashboardJobs(userId: string, query: z.infer<typeof jobsQuerySchema>) {
  const [run] = query.runId || query.scope === 'latest'
    ? await db.select().from(huntRuns).where(and(eq(huntRuns.userId, userId), query.runId ? eq(huntRuns.id, query.runId) : undefined)).orderBy(desc(huntRuns.createdAt)).limit(1)
    : []
  if (query.runId && !run) throw notFound('Hunt run not found')

  // A posting found by multiple hunts appears once, using the latest snapshot.
  // Ownership is applied before deduplication and before pagination.
  const scope = db.$with('scoped_jobs').as(db.selectDistinctOn([huntRunJobs.jobId], {
    ...getTableColumns(huntRunJobs), runStatus: sql<string>`${huntRuns.status}`.as('run_status'), runCreatedAt: sql<Date>`${huntRuns.createdAt}`.as('run_created_at'),
  }).from(huntRunJobs).innerJoin(huntRuns, and(eq(huntRuns.id, huntRunJobs.runId), eq(huntRuns.userId, userId)))
    .where(and(eq(huntRunJobs.userId, userId), run ? eq(huntRunJobs.runId, run.id) : undefined))
    .orderBy(huntRunJobs.jobId, desc(huntRunJobs.discoveredAt), desc(huntRunJobs.id)))
  const eligibility = sql<string>`coalesce(${scope.eligibilityStatus}, case
    when ${scope.status}::text in (${sql.join(ELIGIBILITY_STATUSES.map(v => sql`${v}`), sql`, `)}) then ${scope.status}::text
    when ${huntCandidates.id} is not null then 'eligible' else 'scraped' end)`
  const activeCandidate = sql<boolean>`exists (select 1 from hunt_candidates hc where hc.user_id = ${userId} and hc.job_id = ${scope.jobId} and hc.status::text in (${sql.join(ACTIVE_CANDIDATE_STATUSES.map(v => sql`${v}`), sql`, `)}))`
  const applyUrl = sql<string>`coalesce(nullif(${jobs.applyUrl}, ''), (select nullif(js.apply_url, '') from job_sources js where js.job_id = ${jobs.id} and js.portal_id = ${scope.sourcePortal} order by js.fetched_at desc limit 1), ${jobs.canonicalUrl})`
  const blockedReason = sql<string | null>`case
    when ${applications.id} is not null then 'Already in Applications. Review its progress there.'
    when ${scope.status} = 'closed' then 'This job is closed.'
    when ${activeCandidate} then 'Already being processed. Review it in Applications.'
    when ${scope.runStatus}::text not in (${sql.join(REVIEWABLE_RUNS.map(v => sql`${v}`), sql`, `)}) then 'This hunt is still finding jobs. Select it when discovery finishes.'
    when 'no_applyable_url' = any(${scope.reasons}) or ${applyUrl} ~* ${AGGREGATOR_URL_PATTERN} then 'No direct application URL found. Open the source to apply manually.'
    else null end`
  const fields = {
    snapshot: {
      id: scope.id, runId: scope.runId, jobId: scope.jobId, status: scope.status,
      sourcePortal: scope.sourcePortal, score: scope.score, discoveredAt: scope.discoveredAt,
      runStatus: scope.runStatus,
    }, job: getTableColumns(jobs),
    candidateId: huntCandidates.id, candidateStatus: huntCandidates.status,
    applicationStatus: applications.status,
    eligibility, blockedReason,
  }
  const common = and(
    query.query ? or(ilike(jobs.title, `%${query.query}%`), ilike(jobs.company, `%${query.query}%`), sql`${jobs.skills}::text ilike ${`%${query.query}%`}`) : undefined,
    query.portal ? eq(scope.sourcePortal, query.portal) : undefined,
    query.minScore !== undefined ? gte(scope.score, query.minScore) : undefined,
    query.maxScore !== undefined ? lte(scope.score, query.maxScore) : undefined,
    query.maxExperience !== undefined ? lte(jobs.experienceMin, query.maxExperience) : undefined,
    query.remote ? eq(jobs.remoteMode, query.remote) : undefined,
    query.foundOn ? sql`${localDate(scope.discoveredAt)} = ${query.foundOn}::date` : undefined,
    query.postedOn ? sql`${localDate(jobs.postedAt)} = ${query.postedOn}::date` : undefined,
  )
  const where = and(common, query.status ? eq(eligibility, query.status) : undefined, query.selectableOnly === 'true' ? sql`${blockedReason} is null` : undefined)
  const ordering = query.sort === 'company' ? [asc(jobs.company), asc(jobs.title)]
    : query.sort === 'newest' ? [desc(scope.discoveredAt)]
      : [sql`${scope.score} ${sql.raw(query.sort === 'score-asc' ? 'asc' : 'desc')} nulls last`]
  const [totals, statusRows, portalRows] = await Promise.all([
    db.with(scope).select({ value: count() }).from(scope).$dynamic().innerJoin(jobs, eq(jobs.id, scope.jobId))
    .leftJoin(huntCandidates, and(eq(huntCandidates.runId, scope.runId), eq(huntCandidates.jobId, scope.jobId), eq(huntCandidates.userId, userId)))
    .leftJoin(applications, and(eq(applications.jobId, scope.jobId), eq(applications.userId, userId))).where(where),
    db.with(scope).select({ status: eligibility, value: count() }).from(scope).$dynamic().innerJoin(jobs, eq(jobs.id, scope.jobId))
    .leftJoin(huntCandidates, and(eq(huntCandidates.runId, scope.runId), eq(huntCandidates.jobId, scope.jobId), eq(huntCandidates.userId, userId)))
    .leftJoin(applications, and(eq(applications.jobId, scope.jobId), eq(applications.userId, userId))).where(common).groupBy(sql`1`),
    db.with(scope).select({ portal: scope.sourcePortal, value: count() }).from(scope).$dynamic().innerJoin(jobs, eq(jobs.id, scope.jobId))
    .leftJoin(huntCandidates, and(eq(huntCandidates.runId, scope.runId), eq(huntCandidates.jobId, scope.jobId), eq(huntCandidates.userId, userId)))
    .leftJoin(applications, and(eq(applications.jobId, scope.jobId), eq(applications.userId, userId))).groupBy(scope.sourcePortal),
  ])
  const total = Number(totals[0]?.value ?? 0)
  const totalPages = Math.ceil(total / query.pageSize)
  const page = Math.min(query.page, Math.max(1, totalPages))
  const rows = await db.with(scope).select(fields).from(scope).$dynamic().innerJoin(jobs, eq(jobs.id, scope.jobId))
    .leftJoin(huntCandidates, and(eq(huntCandidates.runId, scope.runId), eq(huntCandidates.jobId, scope.jobId), eq(huntCandidates.userId, userId)))
    .leftJoin(applications, and(eq(applications.jobId, scope.jobId), eq(applications.userId, userId))).where(where).orderBy(...ordering, asc(jobs.id)).limit(query.pageSize).offset((page - 1) * query.pageSize)
  const counts: Record<string, number> = Object.fromEntries(ELIGIBILITY_STATUSES.map(v => [v, 0]))
  counts.all = 0
  for (const row of statusRows) { counts[row.status] = Number(row.value); counts.all += Number(row.value) }
  return {
    run: run ?? null, scope: query.scope, counts, portals: Object.fromEntries(portalRows.map(r => [r.portal, Number(r.value)])),
    historical: Boolean(run && total === 0 && statusRows.length === 0),
    items: rows.map(({ snapshot: row, job, ...state }) => ({
      ...state, id: row.id, jobId: job.id, runId: row.runId, runStatus: row.runStatus,
      selectable: state.blockedReason === null,
      title: job.title, company: job.company, locations: job.locations, remote: job.remoteMode,
      employmentType: job.employmentType, sourcePortal: row.sourcePortal, status: row.status,
      score: row.score, skills: job.skills, salary: salaryOf(job), experience: experienceOf(job),
      experienceMin: job.experienceMin, experienceMax: job.experienceMax, responsibilities: job.responsibilities,
      jobUrl: job.canonicalUrl, postedAt: job.postedAt.toISOString(), discoveredAt: row.discoveredAt.toISOString(),
    })),
    pagination: { page, pageSize: query.pageSize, total, totalPages },
  }
}
