import { and, desc, eq, inArray } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { applications, applyAttempts, huntCandidates } from '../db/schema.js'

const ids = [
  '77a60616-9a9f-401e-a108-b033b6e4d34f',
  'aee06250-730c-42fe-a1b3-712927e7af73',
  'e434fd32-dfa1-4568-b739-767218eb2d2a',
  'ac8ee938-7c1a-4291-99bc-8c5038b6e465',
  '9abd73eb-b210-4dfa-887e-b0e020ff5118',
  'd61ce48b-e77b-4b52-8f3a-3cc43e550e32',
  '56026832-99fd-4a75-b44d-824f37e2daaa',
  '05405e66-30a1-4f98-a95f-520fab6e14a8',
]
const rows = await db.select({
  id: applications.id,
  company: applications.company,
  role: applications.role,
  status: applications.status,
  updatedAt: applications.updatedAt,
  candidateId: huntCandidates.id,
}).from(applications)
  .leftJoin(huntCandidates, and(eq(huntCandidates.userId, applications.userId), eq(huntCandidates.jobId, applications.jobId)))
  .where(inArray(applications.id, ids))

const seen = new Map<string, typeof rows[number]>()
for (const row of rows) seen.set(row.id, row)
const out = []
for (const row of seen.values()) {
  const [attempt] = row.candidateId
    ? await db.select({
      id: applyAttempts.id,
      status: applyAttempts.status,
      error: applyAttempts.error,
      unresolvedFields: applyAttempts.unresolvedFields,
      updatedAt: applyAttempts.updatedAt,
    }).from(applyAttempts)
      .where(eq(applyAttempts.candidateId, row.candidateId))
      .orderBy(desc(applyAttempts.createdAt))
      .limit(1)
    : []
  out.push({
    id: row.id,
    company: row.company,
    role: row.role,
    status: row.status,
    updatedAt: row.updatedAt,
    attempt: attempt ?? null,
  })
}
console.log(JSON.stringify(out, null, 2))
await closeDatabase()
