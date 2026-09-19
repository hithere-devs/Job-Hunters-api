import { and, desc, eq } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { applications, applyAttempts, huntCandidates } from '../db/schema.js'

const id = process.argv[2]
if (!id) throw new Error('application id required')
const [app] = await db.select().from(applications).where(eq(applications.id, id)).limit(1)
if (!app) throw new Error('no application')
const [candidate] = app.jobId && app.huntRunId
  ? await db.select({ id: huntCandidates.id }).from(huntCandidates).where(and(
    eq(huntCandidates.jobId, app.jobId),
    eq(huntCandidates.runId, app.huntRunId),
    eq(huntCandidates.userId, app.userId),
  )).limit(1)
  : []
const attempts = candidate
  ? await db.select().from(applyAttempts).where(eq(applyAttempts.candidateId, candidate.id)).orderBy(desc(applyAttempts.createdAt)).limit(3)
  : []
console.log(JSON.stringify({
  app: { id: app.id, status: app.status, company: app.company, role: app.role, notes: app.notes, jobUrl: app.jobUrl },
  attempts: attempts.map((row) => ({
    id: row.id,
    status: row.status,
    error: row.error,
    unresolved: row.unresolvedFields,
    submitted: row.submittedFields,
    evidence: row.evidenceStoragePath,
    liveUrl: row.liveUrl,
  })),
}, null, 2))
await closeDatabase()
