import { desc, eq } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { applications, huntCandidates, jobs, users } from '../db/schema.js'

const email = process.argv[2] ?? 'mywritingfrenzy@gmail.com'
const [user] = await db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(eq(users.email, email)).limit(1)
console.log('USER', user)
if (!user) {
  await closeDatabase()
  process.exit(0)
}
const cands = await db
  .select({
    id: huntCandidates.id,
    status: huntCandidates.status,
    score: huntCandidates.score,
    title: jobs.title,
    company: jobs.company,
    applyUrl: jobs.applyUrl,
    canonicalUrl: jobs.canonicalUrl,
  })
  .from(huntCandidates)
  .innerJoin(jobs, eq(huntCandidates.jobId, jobs.id))
  .where(eq(huntCandidates.userId, user.id))
  .orderBy(desc(huntCandidates.score))
  .limit(20)
console.log('CANDIDATES', JSON.stringify(cands, null, 2))
const apps = await db
  .select({
    id: applications.id,
    status: applications.status,
    role: applications.role,
    company: applications.company,
    jobUrl: applications.jobUrl,
  })
  .from(applications)
  .where(eq(applications.userId, user.id))
  .orderBy(desc(applications.queuedAt))
  .limit(20)
console.log('APPLICATIONS', JSON.stringify(apps, null, 2))
await closeDatabase()
