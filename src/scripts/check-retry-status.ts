import { desc, eq } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { applications, applyAttempts, users } from '../db/schema.js'

const [user] = await db.select().from(users).where(eq(users.email, 'mywritingfrenzy@gmail.com')).limit(1)
if (!user) throw new Error('no user')
const attempts = await db.select({
  id: applyAttempts.id,
  status: applyAttempts.status,
  error: applyAttempts.error,
  unresolvedFields: applyAttempts.unresolvedFields,
  createdAt: applyAttempts.createdAt,
  candidateId: applyAttempts.candidateId,
}).from(applyAttempts).where(eq(applyAttempts.userId, user.id)).orderBy(desc(applyAttempts.createdAt)).limit(8)
const apps = await db.select({
  id: applications.id,
  company: applications.company,
  status: applications.status,
  updatedAt: applications.updatedAt,
}).from(applications).where(eq(applications.userId, user.id)).orderBy(desc(applications.updatedAt)).limit(8)
console.log(JSON.stringify({ attempts, apps }, null, 2))
await closeDatabase()
