import { desc, eq } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { applications, huntCandidates, jobs, users } from '../db/schema.js'

const people = await db.select({ id: users.id, email: users.email, name: users.name }).from(users).limit(30)
console.log('USERS', people)
const azhar = people.find((user) => /azhar|mywritingfrenzy|huntly/i.test(`${user.email} ${user.name}`)) ?? people[0]
if (!azhar) {
  console.log('no users')
  await closeDatabase()
  process.exit(0)
}
console.log('PICKED', azhar)
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
  .where(eq(huntCandidates.userId, azhar.id))
  .orderBy(desc(huntCandidates.score))
  .limit(25)
console.log('CANDIDATES', cands)
const apps = await db
  .select({
    id: applications.id,
    status: applications.status,
    role: applications.role,
    company: applications.company,
    jobUrl: applications.jobUrl,
  })
  .from(applications)
  .where(eq(applications.userId, azhar.id))
  .orderBy(desc(applications.queuedAt))
  .limit(15)
console.log('APPLICATIONS', apps)
await closeDatabase()
