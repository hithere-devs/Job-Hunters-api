import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { and, desc, eq, gte, inArray } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { applications, applyAttempts, applicationEvents, attemptEvents, huntCandidates, jobs, users } from '../db/schema.js'
import { createSignedUrl, downloadObject } from '../lib/storage.js'

const scratch = '/var/folders/zr/m5g6gwyn5kn1vqkgqf_tw8380000gn/T/grok-goal-41b61aaa2700/implementer'
const shotsDir = path.join(scratch, 'shots')
await mkdir(shotsDir, { recursive: true })

const email = 'mywritingfrenzy@gmail.com'
const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
if (!user) throw new Error(`no user ${email}`)

const start = new Date('2026-09-19T00:00:00.000Z')
const rows = await db.select({
  applicationId: applications.id,
  status: applications.status,
  company: applications.company,
  role: applications.role,
  notes: applications.notes,
  jobUrl: applications.jobUrl,
  queuedAt: applications.queuedAt,
  updatedAt: applications.updatedAt,
  appliedAt: applications.appliedAt,
  jobId: applications.jobId,
  applyUrl: jobs.applyUrl,
  canonicalUrl: jobs.canonicalUrl,
  candidateId: huntCandidates.id,
  candidateStatus: huntCandidates.status,
}).from(applications)
  .leftJoin(jobs, eq(jobs.id, applications.jobId))
  .leftJoin(huntCandidates, and(eq(huntCandidates.userId, user.id), eq(huntCandidates.jobId, applications.jobId)))
  .where(and(
    eq(applications.userId, user.id),
    inArray(applications.status, ['needs_review', 'failed', 'queued', 'applied']),
    gte(applications.queuedAt, start),
  ))
  .orderBy(desc(applications.queuedAt))

const out = []
for (const row of rows) {
  const attempts = row.candidateId
    ? await db.select().from(applyAttempts)
      .where(and(eq(applyAttempts.userId, user.id), eq(applyAttempts.candidateId, row.candidateId)))
      .orderBy(desc(applyAttempts.createdAt))
      .limit(5)
    : []
  const latest = attempts[0] ?? null
  const events = latest ? await db.select().from(attemptEvents)
    .where(eq(attemptEvents.attemptId, latest.id))
    .orderBy(desc(attemptEvents.at))
    .limit(40) : []
  const appEvents = await db.select().from(applicationEvents)
    .where(eq(applicationEvents.applicationId, row.applicationId))
    .orderBy(desc(applicationEvents.createdAt))
    .limit(15)

  let evidencePath = latest?.evidenceStoragePath ?? null
  let evidenceUrl = null
  let localShot = null
  if (evidencePath) {
    try {
      evidenceUrl = await createSignedUrl(evidencePath, 3600)
      const buf = await downloadObject(evidencePath)
      localShot = path.join(shotsDir, `${row.applicationId}.png`)
      await writeFile(localShot, buf)
    } catch (error) {
      localShot = `download-failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  out.push({
    applicationId: row.applicationId,
    status: row.status,
    company: row.company,
    role: row.role,
    notes: row.notes,
    jobUrl: row.jobUrl,
    applyUrl: row.applyUrl,
    canonicalUrl: row.canonicalUrl,
    queuedAt: row.queuedAt,
    updatedAt: row.updatedAt,
    appliedAt: row.appliedAt,
    candidateStatus: row.candidateStatus,
    attempt: latest ? {
      id: latest.id,
      status: latest.status,
      error: latest.error,
      unresolvedFields: latest.unresolvedFields,
      evidenceStoragePath: latest.evidenceStoragePath,
      submitStartedAt: latest.submitStartedAt,
      startedAt: latest.startedAt,
      completedAt: latest.completedAt,
      createdAt: latest.createdAt,
      updatedAt: latest.updatedAt,
    } : null,
    attemptCount: attempts.length,
    attemptStatuses: attempts.map((a) => ({ id: a.id, status: a.status, error: a.error, createdAt: a.createdAt })),
    recentAttemptEvents: events.map((e) => ({ state: e.state, reason: e.reason, detail: e.detail, at: e.at })),
    recentAppEvents: appEvents.map((e) => ({ from: e.fromStatus, to: e.toStatus, note: e.note, at: e.createdAt })),
    evidenceUrl,
    localShot,
  })
}

await writeFile(path.join(scratch, 'today-apps.json'), JSON.stringify({ userId: user.id, count: out.length, rows: out }, null, 2))
console.log(JSON.stringify({ userId: user.id, count: out.length, summary: out.map((r) => ({
  company: r.company, role: r.role, status: r.status, queuedAt: r.queuedAt,
  attemptStatus: r.attempt?.status, error: r.attempt?.error, unresolved: r.attempt?.unresolvedFields, shot: r.localShot,
})) }, null, 2))
await closeDatabase()
