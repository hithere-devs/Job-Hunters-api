import { and, desc, eq } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { applications, huntCandidates, huntRunJobs, huntRuns, jobs, users } from '../db/schema.js'
import { enqueueApprovedCandidates } from '../hunt/application-queue.js'

const email = process.argv[2] ?? 'mywritingfrenzy@gmail.com'
const limit = Number(process.argv[3] ?? 10)
const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email)).limit(1)
if (!user) throw new Error(`no user ${email}`)

let [run] = await db
  .select({ id: huntRuns.id, status: huntRuns.status })
  .from(huntRuns)
  .where(eq(huntRuns.userId, user.id))
  .orderBy(desc(huntRuns.createdAt))
  .limit(1)
if (!run) {
  const [created] = await db.insert(huntRuns).values({ userId: user.id, status: 'applying', targetApplications: limit }).returning({ id: huntRuns.id, status: huntRuns.status })
  run = created
}
if (!run) throw new Error('no hunt run')
await db.update(huntRuns).set({ targetApplications: limit, status: 'applying' }).where(eq(huntRuns.id, run.id))

const applied = new Set(
  (await db.select({ jobId: applications.jobId }).from(applications).where(eq(applications.userId, user.id)))
    .map((row) => row.jobId)
    .filter((id): id is string => Boolean(id)),
)

const rows = await db
  .select({
    id: huntCandidates.id,
    jobId: huntCandidates.jobId,
    runId: huntCandidates.runId,
    status: huntCandidates.status,
    score: huntCandidates.score,
    sourcePortal: huntCandidates.sourcePortal,
    title: jobs.title,
    company: jobs.company,
    applyUrl: jobs.applyUrl,
    canonicalUrl: jobs.canonicalUrl,
  })
  .from(huntCandidates)
  .innerJoin(jobs, eq(huntCandidates.jobId, jobs.id))
  .where(eq(huntCandidates.userId, user.id))
  .orderBy(desc(huntCandidates.score))
  .limit(200)

const eligible = rows.filter((row) => {
  if (applied.has(row.jobId)) return false
  const url = `${row.applyUrl ?? ''} ${row.canonicalUrl ?? ''}`
  if (!/greenhouse|ashbyhq|lever\.co|smartrecruiters|workable/i.test(url)) return false
  if (/mongodb|mercor|atlan|gitlab|supabase/i.test(`${row.company} ${url}`)) return false
  return ['discovered', 'rejected', 'approved'].includes(row.status)
})

const picked = []
const seenJobs = new Set<string>()
for (const row of eligible) {
  if (seenJobs.has(row.jobId)) continue
  seenJobs.add(row.jobId)
  picked.push(row)
  if (picked.length >= limit) break
}
if (!picked.length) throw new Error('no queueable ATS jobs that have not already been applied')

const ids: string[] = []
for (const row of picked) {
  if (row.runId === run.id) {
    ids.push(row.id)
    continue
  }
  await db.insert(huntRunJobs).values({
    runId: run.id,
    userId: user.id,
    jobId: row.jobId,
    sourcePortal: row.sourcePortal,
    status: 'scraped',
    score: row.score,
    scoreBreakdown: { test: true },
    reasons: ['manual ten-apply'],
  }).onConflictDoNothing()
  const [copy] = await db.insert(huntCandidates).values({
    runId: run.id,
    userId: user.id,
    jobId: row.jobId,
    sourcePortal: row.sourcePortal,
    score: row.score,
    scoreBreakdown: { test: true },
    reasons: ['manual ten-apply'],
    status: 'discovered',
  }).onConflictDoNothing().returning({ id: huntCandidates.id })
  const id = copy?.id ?? (await db.select({ id: huntCandidates.id }).from(huntCandidates).where(and(eq(huntCandidates.runId, run.id), eq(huntCandidates.jobId, row.jobId))).limit(1))[0]?.id
  if (id) ids.push(id)
}

const result = await enqueueApprovedCandidates(user.id, run.id, ids)
console.log(JSON.stringify({
  runId: run.id,
  requested: picked.map((row) => ({ company: row.company, title: row.title, score: row.score, applyUrl: row.applyUrl ?? row.canonicalUrl })),
  result,
}, null, 2))
await closeDatabase()
