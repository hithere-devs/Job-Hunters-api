import { and, desc, eq, inArray } from 'drizzle-orm'
import { db, closeDatabase } from '../db/client.js'
import { applications, applyAttempts, huntCandidates } from '../db/schema.js'

const userId = '1d4f5036-09a1-4df5-8509-e3ac99626b80'
const ids = [
  '1be3def6-6a3f-4a53-a8f6-7243b70419f3',
  '38db9f06-fdc3-4134-93aa-a4a856daa45c',
  'f06ced0a-4879-44fa-a621-9165c4e77e36',
  'f7f035cc-1f21-40ca-a3c4-c218cfe10bdd',
]

async function snapshot() {
  const rows = await db.select({
    id: applications.id,
    role: applications.role,
    company: applications.company,
    status: applications.status,
    jobId: applications.jobId,
    huntRunId: applications.huntRunId,
  }).from(applications).where(and(eq(applications.userId, userId), inArray(applications.id, ids)))
  const out = []
  let pending = 0
  for (const row of rows) {
    const [candidate] = row.jobId && row.huntRunId
      ? await db.select({ id: huntCandidates.id, status: huntCandidates.status }).from(huntCandidates)
        .where(and(eq(huntCandidates.userId, userId), eq(huntCandidates.jobId, row.jobId), eq(huntCandidates.runId, row.huntRunId))).limit(1)
      : []
    const [attempt] = candidate
      ? await db.select({
        id: applyAttempts.id,
        status: applyAttempts.status,
        error: applyAttempts.error,
        unresolvedFields: applyAttempts.unresolvedFields,
        submitStartedAt: applyAttempts.submitStartedAt,
        createdAt: applyAttempts.createdAt,
      }).from(applyAttempts).where(and(eq(applyAttempts.candidateId, candidate.id), eq(applyAttempts.userId, userId)))
        .orderBy(desc(applyAttempts.createdAt)).limit(1)
      : []
    const live = ['queued', 'applying'].includes(candidate?.status ?? '') || ['queued', 'applying'].includes(row.status)
    if (live) pending += 1
    out.push({
      company: row.company,
      status: row.status,
      candidate: candidate?.status ?? null,
      attempt: attempt?.status ?? null,
      error: attempt?.error ?? null,
      unresolved: attempt?.unresolvedFields ?? null,
      fenced: Boolean(attempt?.submitStartedAt),
      attemptId: attempt?.id ?? null,
      attemptAt: attempt?.createdAt?.toISOString() ?? null,
      live,
    })
  }
  return { pending, rows: out }
}

async function main() {
  const deadline = Date.now() + 40 * 60_000
  while (true) {
    const snap = await snapshot()
    console.log(JSON.stringify({ at: new Date().toISOString(), ...snap }))
    if (snap.pending === 0) return
    if (Date.now() >= deadline) {
      console.log(JSON.stringify({ timedOut: true, pending: snap.pending }))
      process.exitCode = 2
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 45_000))
  }
}

main().finally(() => closeDatabase())
