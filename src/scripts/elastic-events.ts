import { and, desc, eq } from 'drizzle-orm'
import { db, closeDatabase } from '../db/client.js'
import { applications, applyAttempts, attemptEvents, huntCandidates } from '../db/schema.js'

const userId = '1d4f5036-09a1-4df5-8509-e3ac99626b80'
const applicationId = process.argv[2] ?? '38db9f06-fdc3-4134-93aa-a4a856daa45c'

async function main() {
  const [app] = await db.select().from(applications).where(and(eq(applications.id, applicationId), eq(applications.userId, userId))).limit(1)
  const [candidate] = await db.select({ id: huntCandidates.id }).from(huntCandidates)
    .where(and(eq(huntCandidates.userId, userId), eq(huntCandidates.jobId, app!.jobId!), eq(huntCandidates.runId, app!.huntRunId!))).limit(1)
  const [attempt] = await db.select().from(applyAttempts).where(and(eq(applyAttempts.candidateId, candidate!.id), eq(applyAttempts.userId, userId))).orderBy(desc(applyAttempts.createdAt)).limit(1)
  const events = await db.select({ state: attemptEvents.state, reason: attemptEvents.reason, at: attemptEvents.at, detail: attemptEvents.detail })
    .from(attemptEvents).where(eq(attemptEvents.attemptId, attempt!.id)).orderBy(attemptEvents.at)
  console.log(JSON.stringify({
    attemptId: attempt!.id,
    status: attempt!.status,
    error: attempt!.error,
    unresolved: attempt!.unresolvedFields,
    submitStartedAt: attempt!.submitStartedAt,
    events: events.map((event) => ({
      state: event.state,
      reason: event.reason,
      at: event.at.toISOString(),
      detail: event.detail,
    })),
  }, null, 2))
}

main().finally(() => closeDatabase())
