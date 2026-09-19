import { and, desc, eq, sql } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { applications, applyAttempts, huntCandidates, jobSources, jobs, users } from '../db/schema.js'

const email = process.argv[2] ?? 'mywritingfrenzy@gmail.com'
const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email)).limit(1)
if (!user) throw new Error(`no user ${email}`)

const apps = await db.select({
  id: applications.id,
  status: applications.status,
  company: applications.company,
  role: applications.role,
  jobId: applications.jobId,
  huntRunId: applications.huntRunId,
  portalId: applications.portalId,
  jobUrl: applications.jobUrl,
  notes: applications.notes,
  appliedAt: applications.appliedAt,
  updatedAt: applications.updatedAt,
}).from(applications).where(eq(applications.userId, user.id)).orderBy(desc(applications.updatedAt)).limit(80)

const rows = []
const portalCounts = new Map<string, number>()
for (const app of apps) {
  const [candidate] = app.jobId && app.huntRunId
    ? await db.select({
      id: huntCandidates.id,
      status: huntCandidates.status,
      sourcePortal: huntCandidates.sourcePortal,
    }).from(huntCandidates).where(and(
      eq(huntCandidates.userId, user.id),
      eq(huntCandidates.jobId, app.jobId),
      eq(huntCandidates.runId, app.huntRunId),
    )).limit(1)
    : []
  const [attempt] = candidate
    ? await db.select({
      id: applyAttempts.id,
      status: applyAttempts.status,
      error: applyAttempts.error,
      submitStartedAt: applyAttempts.submitStartedAt,
      unresolvedFields: applyAttempts.unresolvedFields,
    }).from(applyAttempts).where(and(eq(applyAttempts.candidateId, candidate.id), eq(applyAttempts.userId, user.id)))
      .orderBy(desc(applyAttempts.createdAt)).limit(1)
    : []
  const [job] = app.jobId
    ? await db.select({ applyUrl: jobs.applyUrl, canonicalUrl: jobs.canonicalUrl }).from(jobs).where(eq(jobs.id, app.jobId)).limit(1)
    : []
  const sources = app.jobId
    ? await db.select({ portalId: jobSources.portalId, applyUrl: jobSources.applyUrl }).from(jobSources).where(eq(jobSources.jobId, app.jobId))
    : []
  const portal = candidate?.sourcePortal ?? app.portalId ?? sources[0]?.portalId ?? 'unknown'
  portalCounts.set(portal, (portalCounts.get(portal) ?? 0) + 1)
  rows.push({
    applicationId: app.id,
    company: app.company,
    role: app.role,
    status: app.status,
    candidateStatus: candidate?.status ?? null,
    attemptStatus: attempt?.status ?? null,
    attemptError: attempt?.error ?? null,
    submitStartedAt: attempt?.submitStartedAt?.toISOString() ?? null,
    unresolved: attempt?.unresolvedFields ?? null,
    portal,
    applyUrl: job?.applyUrl ?? app.jobUrl,
    canonicalUrl: job?.canonicalUrl ?? null,
    sources,
  })
}

const open = await db.select({
  candidateId: huntCandidates.id,
  status: huntCandidates.status,
  sourcePortal: huntCandidates.sourcePortal,
  jobId: huntCandidates.jobId,
  runId: huntCandidates.runId,
  title: jobs.title,
  company: jobs.company,
  applyUrl: jobs.applyUrl,
  canonicalUrl: jobs.canonicalUrl,
}).from(huntCandidates)
  .innerJoin(jobs, eq(jobs.id, huntCandidates.jobId))
  .where(and(
    eq(huntCandidates.userId, user.id),
    sql`${huntCandidates.status} in ('approved','queued','tailored','applying')`,
  ))
  .orderBy(desc(huntCandidates.updatedAt))
  .limit(40)

const statusCounts = await db.select({
  status: applications.status,
  n: sql<number>`count(*)::int`,
}).from(applications).where(eq(applications.userId, user.id)).groupBy(applications.status)

console.log(JSON.stringify({ userId: user.id, statusCounts, portalCounts: Object.fromEntries(portalCounts), rows, open }, null, 2))
await closeDatabase()
