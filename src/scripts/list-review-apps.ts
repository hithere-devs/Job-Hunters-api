import { and, desc, eq } from 'drizzle-orm'
import { db, closeDatabase } from '../db/client.js'
import { applications, applyAttempts, huntCandidates, users } from '../db/schema.js'

async function main() {
  const email = 'mywritingfrenzy@gmail.com'
  const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email)).limit(1)
  if (!user) throw new Error('user not found')
  const rows = await db.select({
    id: applications.id,
    role: applications.role,
    company: applications.company,
    status: applications.status,
    notes: applications.notes,
    jobId: applications.jobId,
    huntRunId: applications.huntRunId,
  }).from(applications).where(eq(applications.userId, user.id)).orderBy(desc(applications.updatedAt)).limit(40)

  const out = []
  for (const row of rows) {
    const [candidate] = row.jobId && row.huntRunId
      ? await db.select({ id: huntCandidates.id, status: huntCandidates.status }).from(huntCandidates)
        .where(and(eq(huntCandidates.userId, user.id), eq(huntCandidates.jobId, row.jobId), eq(huntCandidates.runId, row.huntRunId))).limit(1)
      : []
    const [attempt] = candidate
      ? await db.select({
        id: applyAttempts.id,
        status: applyAttempts.status,
        error: applyAttempts.error,
        submitStartedAt: applyAttempts.submitStartedAt,
        createdAt: applyAttempts.createdAt,
      }).from(applyAttempts).where(and(eq(applyAttempts.candidateId, candidate.id), eq(applyAttempts.userId, user.id)))
        .orderBy(desc(applyAttempts.createdAt)).limit(1)
      : []
    out.push({
      applicationId: row.id,
      role: row.role,
      company: row.company,
      status: row.status,
      notes: row.notes,
      candidateStatus: candidate?.status ?? null,
      attemptStatus: attempt?.status ?? null,
      attemptError: attempt?.error ?? null,
      submitStartedAt: attempt?.submitStartedAt?.toISOString() ?? null,
      attemptAt: attempt?.createdAt?.toISOString() ?? null,
    })
  }
  console.log(JSON.stringify({ userId: user.id, count: out.length, rows: out }, null, 2))
}

main().finally(() => closeDatabase())
