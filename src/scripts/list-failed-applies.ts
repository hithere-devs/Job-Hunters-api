import { and, desc, eq, inArray } from 'drizzle-orm'
import { db, closeDatabase } from '../db/client.js'
import { applications, applyAttempts, huntCandidates, jobs, users } from '../db/schema.js'

const BLOCKED_JOBS = new Set([
  '06c96dcc-39d3-469c-8f16-09551e91af73', // Atlan
  '1215137d-7a69-409d-9cac-3c38ebc9c0cd', // Mercor Infra
  'a9dc23be-8471-41a2-8806-67d576c4ace6', // Fullstack
])
const email = process.argv[2] ?? 'mywritingfrenzy@gmail.com'
const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
if (!user) throw new Error(`no user ${email}`)

const rows = await db.select({
  applicationId: applications.id,
  status: applications.status,
  company: applications.company,
  role: applications.role,
  jobId: applications.jobId,
  applyUrl: jobs.applyUrl,
  canonicalUrl: jobs.canonicalUrl,
  candidateId: huntCandidates.id,
  candidateStatus: huntCandidates.status,
  runId: huntCandidates.runId,
}).from(applications)
  .innerJoin(jobs, eq(jobs.id, applications.jobId))
  .innerJoin(huntCandidates, and(eq(huntCandidates.userId, user.id), eq(huntCandidates.jobId, applications.jobId)))
  .where(and(eq(applications.userId, user.id), inArray(applications.status, ['needs_review', 'queued'])))
  .orderBy(desc(applications.updatedAt))
  .limit(40)

const out = []
for (const row of rows) {
  const [attempt] = await db.select({
    id: applyAttempts.id,
    status: applyAttempts.status,
    error: applyAttempts.error,
    unresolvedFields: applyAttempts.unresolvedFields,
    updatedAt: applyAttempts.updatedAt,
  }).from(applyAttempts)
    .where(and(eq(applyAttempts.userId, user.id), eq(applyAttempts.candidateId, row.candidateId)))
    .orderBy(desc(applyAttempts.createdAt))
    .limit(1)
  out.push({
    ...row,
    blocked: Boolean(row.jobId && BLOCKED_JOBS.has(row.jobId)),
    attempt: attempt ? {
      id: attempt.id,
      status: attempt.status,
      error: attempt.error,
      updatedAt: attempt.updatedAt,
      unresolved: attempt.unresolvedFields,
    } : null,
  })
}
console.log(JSON.stringify(out, null, 2))
await closeDatabase()
