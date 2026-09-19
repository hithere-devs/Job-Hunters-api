import { and, asc, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/client.js'
import {
  applicationEvents,
  applications,
  applicationStatusEnum,
  applyAttempts,
  attemptEvents,
  huntCandidates,
  portals,
  type Application,
  type ApplicationStatus,
} from '../../db/schema.js'
import { badRequest, notFound } from '../../lib/errors.js'
import { asyncHandler, created, ok, pathParam } from '../../lib/http.js'
import { createSignedUrl } from '../../lib/storage.js'
import { toRelativeLabel } from '../../lib/time.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { reconcileApplicationRecords, applicationRuntimes } from './runtime.js'
import { resolvePendingQuestions } from './question-resolution.js'
import { liveAnswerSchema } from '../../hunt/apply/question-policy.js'
import { listApplicationQuestions,listQuestionInbox,answerQuestions } from './questions.js'
import { safeRetryReason } from '../../hunt/application-policy.js'
import { applicationPreflight } from './preflight.js'
import { applicationQueueHealth } from '../../hunt/application-queue.js'
import { cancelApplication, retryApplication, flagApplication } from './actions.js'
import { recordActivity } from '../../services/activity.js'

export const applicationsRouter: Router = Router()
applicationsRouter.use(requireAuth)

const STATUSES = applicationStatusEnum.enumValues

const listQuerySchema = z.object({
  status: z.enum(['all', ...STATUSES]).default('all'),
  /** Matches role or company, case-insensitive. */
  q: z.string().trim().max(200).optional(),
  portal: z.string().trim().max(60).optional(),
  minMatchScore: z.coerce.number().int().min(0).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['recent', 'match', 'company']).default('recent'),
})

const idParamSchema = z.object({ id: z.string().uuid() })

const statusSchema = z.object({
  status: z.enum(STATUSES),
  note: z.string().trim().max(1000).optional(),
})

const createSchema = z.object({
  role: z.string().trim().min(1).max(200),
  company: z.string().trim().min(1).max(200),
  logo: z.string().trim().max(16).optional(),
  location: z.string().trim().max(200).optional(),
  salary: z.string().trim().max(120).optional(),
  jobUrl: z.string().trim().url().max(2000).optional(),
  jobDescription: z.string().max(50_000).optional(),
  externalJobId: z.string().trim().max(120).optional(),
  portalId: z.string().trim().max(60).optional(),
  portalName: z.string().trim().max(120).optional(),
  matchScore: z.coerce.number().int().min(0).max(100).optional(),
  status: z.enum(STATUSES).default('queued'),
  resumeVariantId: z.string().uuid().optional(),
  resumeVariantName: z.string().trim().max(200).optional(),
})

/** Mirrors the `Application` type in the UI's mock data, plus raw timestamps. */
interface ApplicationDto {
  id: string
  role: string
  company: string
  logo: string
  location: string
  portal: string
  salary: string
  matchScore: number
  status: ApplicationStatus
  /** Pre-formatted: "2 days ago", "5 hours ago", "in queue". */
  appliedAt: string
  resumeVariant: string
  jobUrl: string | null
  externalJobId: string | null
  appliedAtIso: string | null
  queuedAtIso: string
  updatedAtIso: string
}

function serializeApplication(row: Application, now = new Date()): ApplicationDto {
  return {
    id: row.id,
    role: row.role,
    company: row.company,
    logo: row.logo,
    location: row.location ?? '',
    portal: row.portalName ?? row.portalId ?? '',
    salary: row.salary ?? '',
    matchScore: row.matchScore ?? 0,
    status: row.status,
    appliedAt:
      row.status === 'queued' ? 'in queue' : toRelativeLabel(row.appliedAt ?? row.createdAt, now),
    resumeVariant: row.resumeVariantName ?? '',
    jobUrl: row.jobUrl,
    externalJobId: row.externalJobId,
    appliedAtIso: row.appliedAt?.toISOString() ?? null,
    queuedAtIso: row.queuedAt.toISOString(),
    updatedAtIso: row.updatedAt.toISOString(),
  }
}

/**
 * Which transitions are allowed.
 *
 * A rejection is terminal — a portal that has said no does not un-say it, and
 * letting the status walk backwards would make the funnel numbers on the Den
 * screen meaningless. Everything else can move forward, and `viewed` can go to
 * `interview` or `rejected`. Re-setting the same status is a no-op rather than
 * an error, so a retrying webhook is harmless.
 */
const ALLOWED_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  queued: ['applied', 'rejected', 'needs_review', 'failed', 'closed'],
  applied: ['viewed', 'interview', 'rejected', 'closed'],
  viewed: ['interview', 'rejected', 'closed'],
  interview: ['rejected', 'closed'],
  rejected: [],
  needs_review: ['queued', 'applied', 'failed', 'closed'],
  failed: ['queued', 'needs_review'],
  closed: [],
}

const STATUS_TIMESTAMP: Record<ApplicationStatus, keyof Application | null> = {
  queued: null,
  applied: 'appliedAt',
  viewed: 'viewedAt',
  interview: 'interviewAt',
  rejected: 'rejectedAt',
  needs_review: null,
  failed: null,
  closed: null,
}

applicationsRouter.post('/:id/recover-questions',validate({params:idParamSchema}),asyncHandler(async(req,res)=>{
 ok(res,await retryApplication(currentUser(req).id,pathParam(req,'id')))
}))
applicationsRouter.post('/questions/resolve',validate({body:z.object({questionIds:z.array(z.string().uuid()).min(1).max(30).optional(),retry:z.boolean().optional(),includePreviousResponses:z.boolean().optional()}).strict()}),asyncHandler(async(req,res)=>{
 ok(res,await resolvePendingQuestions(currentUser(req).id,req.body.questionIds,{retry:req.body.retry,includePreviousResponses:req.body.includePreviousResponses}))
}))
applicationsRouter.get('/questions',asyncHandler(async(req,res)=>{ok(res,await listQuestionInbox(currentUser(req).id))}))
applicationsRouter.post('/questions/answers',validate({body:z.object({answers:z.array(liveAnswerSchema.extend({questionId:z.string().uuid()})).min(1).max(500)})}),asyncHandler(async(req,res)=>{ok(res,await answerQuestions(currentUser(req).id,req.body.answers))}))
applicationsRouter.get('/:id/questions',validate({params:idParamSchema}),asyncHandler(async(req,res)=>{ok(res,await listApplicationQuestions(currentUser(req).id,pathParam(req,'id')))}))
applicationsRouter.post('/:id/questions/:questionId/answer',validate({params:idParamSchema.extend({questionId:z.string().uuid()}),body:liveAnswerSchema}),asyncHandler(async(req,res)=>{
 const result=await answerQuestions(currentUser(req).id,[{...req.body,questionId:pathParam(req,'questionId')}],pathParam(req,'id'))
 ok(res,{...result,saved:true,status:req.body.skip?'skipped':'answered',willContinue:result.continuedApplicationIds.length>0||result.queuedApplicationIds.length>0})
}))

applicationsRouter.get('/active', asyncHandler(async(req,res) => {
  const userId=currentUser(req).id
  const rows=await db.select({application:applications}).from(applications).innerJoin(huntCandidates,and(eq(huntCandidates.userId,userId),eq(huntCandidates.jobId,applications.jobId),eq(huntCandidates.runId,applications.huntRunId)))
    .where(and(eq(applications.userId,userId),eq(huntCandidates.status,'applying'))).orderBy(asc(applications.queuedAt)).limit(4)
  const runtimes=await applicationRuntimes(userId,rows.map(row=>row.application.id))
  ok(res,rows.map(row=>({...serializeApplication(row.application),runtime:runtimes.get(row.application.id)??null})).filter(row=>row.runtime?.active))
}))

applicationsRouter.get('/health', asyncHandler(async (_req, res) => { ok(res, await applicationQueueHealth()) }))
applicationsRouter.get('/preflight', asyncHandler(async (req, res) => {
  const portals = typeof req.query.portals === 'string' ? req.query.portals.split(',').filter(Boolean).slice(0, 30) : []
  ok(res, await applicationPreflight(currentUser(req).id, portals))
}))
applicationsRouter.post('/:id/cancel', validate({params:idParamSchema}), asyncHandler(async(req,res) => {
  ok(res, await cancelApplication(currentUser(req).id,pathParam(req,'id')))
}))
applicationsRouter.post('/:id/retry', validate({params:idParamSchema,body:z.object({confirmedNotSubmitted:z.literal(true)})}), asyncHandler(async(req,res) => {
  const preflight = await applicationPreflight(currentUser(req).id)
  if (!preflight.canApply) throw badRequest('Resolve application readiness issues before retrying.', {gaps:preflight.gaps})
  ok(res, await retryApplication(currentUser(req).id,pathParam(req,'id'),{confirmedNotSubmitted:true}))
}))
applicationsRouter.post('/:id/flag', validate({params:idParamSchema,body:z.object({note:z.string().trim().max(1000).optional()})}), asyncHandler(async(req,res) => {
  ok(res, await flagApplication(currentUser(req).id,pathParam(req,'id'),req.body.note))
}))

applicationsRouter.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const query = validatedQuery<z.infer<typeof listQuerySchema>>(req)
    await reconcileApplicationRecords(auth.id)

    const filters: SQL[] = [eq(applications.userId, auth.id)]

    if (query.status !== 'all') {
      filters.push(eq(applications.status, query.status))
    }
    if (query.q) {
      const needle = `%${query.q}%`
      const search = or(
        ilike(applications.role, needle),
        ilike(applications.company, needle),
        ilike(applications.location, needle),
      )
      if (search) filters.push(search)
    }
    if (query.portal) {
      filters.push(eq(applications.portalId, query.portal))
    }
    if (query.minMatchScore !== undefined) {
      filters.push(sql`${applications.matchScore} >= ${query.minMatchScore}`)
    }

    const where = and(...filters)

    const orderBy =
      query.sort === 'match'
        ? [desc(applications.matchScore), desc(applications.createdAt)]
        : query.sort === 'company'
          ? [asc(applications.company), asc(applications.role)]
          : // "recent": applied first, most recent at the top, with queued rows
            // (which have no appliedAt) falling back to when they were queued.
            [desc(sql`coalesce(${applications.appliedAt}, ${applications.queuedAt})`)]

    type ApplicationListRow = {
      application: Application
      filtered_total: number
      status_counts: Record<string, number>
    }

    // Total and status counts used to be two extra round trips. Windowing the
    // filtered total and calculating the unfiltered counts in a correlated
    // subquery keeps the list, pagination metadata and filter chips in one
    // query — important while the database is hosted several hundred ms away.
    const rowsWithMeta = await db
      .select({
        application: applications,
        filtered_total: sql<number>`count(*) over ()`,
        status_counts: sql<Record<string, number>>`coalesce((
          select json_object_agg(status, value)
          from (
            select ${applications.status} as status, count(*)::int as value
            from ${applications}
            where ${applications.userId} = ${auth.id}
            group by ${applications.status}
          ) as status_counts
        ), '{}'::json)`,
      })
      .from(applications)
      .where(where)
      .orderBy(...orderBy)
      .limit(query.limit)
      .offset(query.offset)

    let total = Number((rowsWithMeta[0] as ApplicationListRow | undefined)?.filtered_total ?? 0)
    let statusCounts = (rowsWithMeta[0] as ApplicationListRow | undefined)?.status_counts ?? {}

    // Preserve correct counts for an empty page (including a valid page beyond
    // the end of the result set). This is the uncommon case, so it pays the
    // extra query only when the one-query path has no row to carry metadata.
    if (rowsWithMeta.length === 0) {
      const metaResult = await db.execute(
        sql<{ filtered_total: number; status_counts: Record<string, number> }>`
          select
            (select count(*)::int from ${applications} where ${where}) as filtered_total,
            coalesce((
              select json_object_agg(status, value)
              from (
                select ${applications.status} as status, count(*)::int as value
                from ${applications}
                where ${applications.userId} = ${auth.id}
                group by ${applications.status}
              ) as status_counts
            ), '{}'::json) as status_counts
        `,
      )
      const meta = metaResult.rows[0] as
        | { filtered_total?: number; status_counts?: Record<string, number> }
        | undefined
      total = Number(meta?.filtered_total ?? 0)
      statusCounts = meta?.status_counts ?? {}
    }

    const counts: Record<string, number> = Object.fromEntries(STATUSES.map((status) => [status, 0]))
    for (const [status, value] of Object.entries(statusCounts)) counts[status] = Number(value)

    const now = new Date()
    const runtime = await applicationRuntimes(auth.id, rowsWithMeta.map(row=>row.application.id))
    ok(
      res,
      rowsWithMeta.map((row) => ({ ...serializeApplication(row.application, now), runtime: runtime.get(row.application.id) ?? null, notes: row.application.notes })),
      {
        total,
        limit: query.limit,
        offset: query.offset,
        // Counts are unfiltered on purpose: the filter chips show how many
        // exist in each bucket, not how many survived the current filter.
        counts: { ...counts, all: Object.values(counts).reduce((a, b) => a + b, 0) },
      },
    )
  }),
)

applicationsRouter.get(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)

    const [row] = await db
      .select()
      .from(applications)
      .where(and(eq(applications.id, pathParam(req, 'id')), eq(applications.userId, auth.id)))
      .limit(1)

    if (!row) throw notFound('Application not found')

    const [events, portalRow] = await Promise.all([
      db
        .select()
        .from(applicationEvents)
        .where(eq(applicationEvents.applicationId, row.id))
        .orderBy(asc(applicationEvents.createdAt)),
      row.portalId
        ? db.select().from(portals).where(eq(portals.id, row.portalId)).limit(1)
        : Promise.resolve([]),
    ])

    const [latestAttempt] = row.jobId ? await db.select({id:applyAttempts.id,status:applyAttempts.status,submitStartedAt:applyAttempts.submitStartedAt,error:applyAttempts.error}).from(applyAttempts)
      .innerJoin(huntCandidates,and(eq(huntCandidates.id,applyAttempts.candidateId),eq(huntCandidates.userId,auth.id),eq(huntCandidates.jobId,row.jobId)))
      .where(eq(applyAttempts.userId,auth.id)).orderBy(desc(applyAttempts.createdAt)).limit(1) : []
    const phases = latestAttempt ? await db.select({state:attemptEvents.state,reason:attemptEvents.reason,at:attemptEvents.at,detail:attemptEvents.detail}).from(attemptEvents).where(eq(attemptEvents.attemptId,latestAttempt.id)).orderBy(asc(attemptEvents.at)) : []
    ok(res, {
      ...serializeApplication(row),
      attemptId: latestAttempt?.id ?? null,
      retryBlockedReason: safeRetryReason(row.status,latestAttempt?[latestAttempt]:[],phases,{confirmedNotSubmitted:true}),
      canCancel: row.status === 'queued' && !(await applicationRuntimes(auth.id,[row.id])).get(row.id)?.active,
      attemptTimeline: phases.map(phase=>({state:phase.state,reason:phase.reason,at:phase.at.toISOString()})),
      jobDescription: row.jobDescription,
      notes: row.notes,
      portalDetail: portalRow[0] ?? null,
      allowedNextStatuses: ALLOWED_TRANSITIONS[row.status],
      timeline: events.map((event) => ({
        id: event.id,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        note: event.note,
        at: event.createdAt.toISOString(),
        atLabel: toRelativeLabel(event.createdAt),
      })),
    })
  }),
)

/**
 * What Hunty actually saw, for a `needs_review` application.
 *
 * `applications` and `apply_attempts` have no direct foreign key — both are
 * written from the same `candidateId` inside one apply run, but that pairing
 * is never persisted. This reconstructs it via the hunt candidate the
 * application and the attempt each point back to.
 */
applicationsRouter.get(
  '/:id/review',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)

    const [application] = await db
      .select()
      .from(applications)
      .where(and(eq(applications.id, pathParam(req, 'id')), eq(applications.userId, auth.id)))
      .limit(1)
    if (!application) throw notFound('Application not found')

    if (!application.jobId || !application.huntRunId) {
      return ok(res, { attemptId: null, reason: null, unresolvedFields: [], evidenceUrl: null })
    }

    const [candidate] = await db
      .select({ id: huntCandidates.id })
      .from(huntCandidates)
      .where(and(
        eq(huntCandidates.jobId, application.jobId),
        eq(huntCandidates.runId, application.huntRunId),
        eq(huntCandidates.userId, auth.id),
      ))
      .limit(1)

    const [attempt] = candidate
      ? await db
          .select()
          .from(applyAttempts)
          .where(and(eq(applyAttempts.candidateId, candidate.id), eq(applyAttempts.userId, auth.id)))
          .orderBy(desc(applyAttempts.createdAt))
          .limit(1)
      : []

    if (!attempt) {
      return ok(res, { attemptId: null, reason: null, unresolvedFields: [], evidenceUrl: null })
    }

    ok(res, {
      attemptId: attempt.id,
      reason: attempt.error,
      unresolvedFields: attempt.unresolvedFields ?? [],
      evidenceUrl: attempt.evidenceStoragePath ? await createSignedUrl(attempt.evidenceStoragePath) : null,
    })
  }),
)

/**
 * Move an application along the funnel.
 *
 * This exists for the UI's manual controls and for whatever eventually watches
 * the user's inbox for "we viewed your application" mail. The worker that
 * submits applications writes `applied` through this same path.
 */
applicationsRouter.patch(
  '/:id/status',
  validate({ params: idParamSchema, body: statusSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const { status, note } = req.body as z.infer<typeof statusSchema>

    const [existing] = await db
      .select()
      .from(applications)
      .where(and(eq(applications.id, pathParam(req, 'id')), eq(applications.userId, auth.id)))
      .limit(1)

    if (!existing) throw notFound('Application not found')

    if (status === 'queued' && existing.status !== 'queued') throw badRequest('Use Retry so previous submission evidence and queue state are checked.')
    if (existing.huntRunId && existing.status === 'queued' && status === 'closed') throw badRequest('Use Cancel so the waiting queue job is removed safely.')

    if (existing.status === status) {
      return ok(res, serializeApplication(existing))
    }

    if (!ALLOWED_TRANSITIONS[existing.status].includes(status)) {
      throw badRequest(`Cannot move an application from "${existing.status}" to "${status}".`, {
        allowed: ALLOWED_TRANSITIONS[existing.status],
      })
    }

    const now = new Date()
    const patch: Partial<Application> = { status, updatedAt: now }
    const timestampField = STATUS_TIMESTAMP[status]
    if (timestampField) {
      ;(patch as Record<string, unknown>)[timestampField] = now
    }

    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(applications)
        .set(patch)
        .where(eq(applications.id, existing.id))
        .returning()

      if (!updated) throw notFound('Application not found')

      await tx.insert(applicationEvents).values({
        applicationId: updated.id,
        fromStatus: existing.status,
        toStatus: status,
        note: note ?? null,
      })

      return updated
    })

    await recordActivity({
      userId: auth.id,
      kind: status === 'applied' ? 'application_submitted' : 'application_status_changed',
      text:
        status === 'applied'
          ? `Applied to ${row.role} at ${row.company}`
          : status === 'viewed'
            ? `${row.company} viewed your application`
            : status === 'interview'
              ? `Interview scheduled with ${row.company}`
              : `${row.company} passed on ${row.role}`,
      meta: { applicationId: row.id, status },
    })

    ok(res, serializeApplication(row))
  }),
)

/**
 * Create an application row.
 *
 * The hunt worker is the intended caller — this is how a submitted application
 * gets recorded. It is also how the seed script and manual entry work.
 * TODO(worker-workstream): this currently authenticates as the user; the
 * worker will need a service-to-service credential instead of a user JWT.
 */
applicationsRouter.post(
  '/',
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const body = req.body as z.infer<typeof createSchema>
    const now = new Date()

    const [row] = await db
      .insert(applications)
      .values({
        userId: auth.id,
        role: body.role,
        company: body.company,
        logo: body.logo ?? '🏢',
        location: body.location ?? null,
        salary: body.salary ?? null,
        jobUrl: body.jobUrl ?? null,
        jobDescription: body.jobDescription ?? null,
        externalJobId: body.externalJobId ?? null,
        portalId: body.portalId ?? null,
        portalName: body.portalName ?? null,
        matchScore: body.matchScore ?? null,
        status: body.status,
        resumeVariantId: body.resumeVariantId ?? null,
        resumeVariantName: body.resumeVariantName ?? null,
        appliedAt: body.status === 'queued' ? null : now,
      })
      .returning()

    if (!row) throw new Error('Application insert returned no row')

    await db.insert(applicationEvents).values({
      applicationId: row.id,
      fromStatus: null,
      toStatus: row.status,
      note: 'created',
    })

    if (row.status !== 'queued') {
      await recordActivity({
        userId: auth.id,
        kind: 'application_submitted',
        text: `Applied to ${row.role} at ${row.company}`,
        meta: { applicationId: row.id },
      })
    }

    created(res, serializeApplication(row))
  }),
)

/** CSV export — the "Export CSV" button on the Applications screen. */
applicationsRouter.get(
  '/export/csv',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)

    const rows = await db
      .select()
      .from(applications)
      .where(eq(applications.userId, auth.id))
      .orderBy(desc(sql`coalesce(${applications.appliedAt}, ${applications.queuedAt})`))

    const escape = (value: unknown) => {
      const text = value === null || value === undefined ? '' : String(value)
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }

    const header = [
      'role',
      'company',
      'location',
      'portal',
      'salary',
      'match_score',
      'status',
      'applied_at',
      'resume_variant',
      'job_url',
    ]

    const body = rows.map((row) =>
      [
        row.role,
        row.company,
        row.location,
        row.portalName ?? row.portalId,
        row.salary,
        row.matchScore,
        row.status,
        row.appliedAt?.toISOString() ?? '',
        row.resumeVariantName,
        row.jobUrl,
      ]
        .map(escape)
        .join(','),
    )

    res.setHeader('content-type', 'text/csv; charset=utf-8')
    res.setHeader('content-disposition', 'attachment; filename="job-hunters-applications.csv"')
    res.send([header.join(','), ...body].join('\n'))
  }),
)
