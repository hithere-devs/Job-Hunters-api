import { and, desc, eq } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { applyAttempts, applications, huntCandidates } from '../db/schema.js'

const applicationId = process.argv[2]
if (!applicationId) throw new Error('applicationId required')
const [app] = await db.select().from(applications).where(eq(applications.id, applicationId)).limit(1)
const [candidate] = app?.jobId
  ? await db.select().from(huntCandidates).where(and(eq(huntCandidates.jobId, app.jobId), eq(huntCandidates.userId, app.userId))).limit(1)
  : []
const attempts = candidate
  ? await db.select({
    id: applyAttempts.id,
    status: applyAttempts.status,
    error: applyAttempts.error,
    unresolvedFields: applyAttempts.unresolvedFields,
    submitStartedAt: applyAttempts.submitStartedAt,
    startedAt: applyAttempts.startedAt,
    completedAt: applyAttempts.completedAt,
    updatedAt: applyAttempts.updatedAt,
    createdAt: applyAttempts.createdAt,
  }).from(applyAttempts).where(eq(applyAttempts.candidateId, candidate.id)).orderBy(desc(applyAttempts.createdAt)).limit(3)
  : []
console.log(JSON.stringify({ applicationId, status: app?.status, company: app?.company, attempts }, null, 2))
await closeDatabase()
