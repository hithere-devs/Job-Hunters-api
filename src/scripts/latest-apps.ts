import { desc, eq, inArray } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { applications, applyAttempts, huntCandidates, jobs } from '../db/schema.js'

const rows = await db.select({
  id: applications.id,
  company: applications.company,
  role: applications.role,
  status: applications.status,
  jobId: applications.jobId,
  huntRunId: applications.huntRunId,
  notes: applications.notes,
  updatedAt: applications.updatedAt,
}).from(applications).orderBy(desc(applications.updatedAt)).limit(6)
for (const app of rows) {
  const [c] = app.jobId && app.huntRunId ? await db.select({id:huntCandidates.id,status:huntCandidates.status,portal:huntCandidates.sourcePortal}).from(huntCandidates).where(eq(huntCandidates.jobId, app.jobId)).limit(1) : []
  const [a] = c ? await db.select({status:applyAttempts.status,error:applyAttempts.error,unresolved:applyAttempts.unresolvedFields}).from(applyAttempts).where(eq(applyAttempts.candidateId, c.id)).orderBy(desc(applyAttempts.createdAt)).limit(1) : []
  const [j] = app.jobId ? await db.select({applyUrl:jobs.applyUrl}).from(jobs).where(eq(jobs.id, app.jobId)).limit(1) : []
  console.log(JSON.stringify({ id: app.id, company: app.company, role: app.role, status: app.status, portal: c?.portal, attempt: a?.status, error: a?.error, unresolved: a?.unresolved, applyUrl: j?.applyUrl }, null, 2))
}
await closeDatabase()
