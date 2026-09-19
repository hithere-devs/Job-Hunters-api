import { and, desc, eq, inArray } from 'drizzle-orm'
import { db, closeDatabase } from '../db/client.js'
import { applications, applyAttempts, huntCandidates } from '../db/schema.js'

const userId = '1d4f5036-09a1-4df5-8509-e3ac99626b80'
const ids = [
  '1be3def6-6a3f-4a53-a8f6-7243b70419f3',
  '1215137d-7a69-409d-9cac-3c38ebc9c0cd',
  '06c96dcc-39d3-469c-8f16-09551e91af73',
  '77e7c3d2-1b36-489f-85c1-6b936aee58b9',
  '38db9f06-fdc3-4134-93aa-a4a856daa45c',
  'f06ced0a-4879-44fa-a621-9165c4e77e36',
  'f7f035cc-1f21-40ca-a3c4-c218cfe10bdd',
  'a9dc23be-8471-41a2-8806-67d576c4ace6',
]

async function main() {
  const rows = await db.select({
    id: applications.id,
    role: applications.role,
    company: applications.company,
    status: applications.status,
    jobId: applications.jobId,
    huntRunId: applications.huntRunId,
  }).from(applications).where(and(eq(applications.userId, userId), inArray(applications.id, ids)))

  const out = []
  for (const row of rows) {
    const [candidate] = row.jobId && row.huntRunId
      ? await db.select({ id: huntCandidates.id, status: huntCandidates.status }).from(huntCandidates)
        .where(and(eq(huntCandidates.userId, userId), eq(huntCandidates.jobId, row.jobId), eq(huntCandidates.runId, row.huntRunId))).limit(1)
      : []
    const [attempt] = candidate
      ? await db.select({
        status: applyAttempts.status,
        error: applyAttempts.error,
        submitStartedAt: applyAttempts.submitStartedAt,
        createdAt: applyAttempts.createdAt,
        unresolvedFields: applyAttempts.unresolvedFields,
      }).from(applyAttempts).where(and(eq(applyAttempts.candidateId, candidate.id), eq(applyAttempts.userId, userId)))
        .orderBy(desc(applyAttempts.createdAt)).limit(1)
      : []
    out.push({
      company: row.company,
      role: row.role,
      status: row.status,
      candidate: candidate?.status ?? null,
      attempt: attempt?.status ?? null,
      error: attempt?.error ?? null,
      unresolved: attempt?.unresolvedFields ?? null,
      fenced: Boolean(attempt?.submitStartedAt),
      attemptAt: attempt?.createdAt?.toISOString() ?? null,
    })
  }
  const all = await db.select({ status: applications.status }).from(applications).where(eq(applications.userId, userId))
  const counts = all.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1
    return acc
  }, {})
  console.log(JSON.stringify({ counts, rows: out }, null, 2))
}

main().finally(() => closeDatabase())
