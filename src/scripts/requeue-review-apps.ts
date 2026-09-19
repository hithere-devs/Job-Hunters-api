import { and, desc, eq, gte, inArray, or } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { applications, users } from '../db/schema.js'
import { retryApplication } from '../modules/applications/actions.js'

const email = process.argv[2] ?? 'mywritingfrenzy@gmail.com'
const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
if (!user) throw new Error('no user')
const start = new Date()
start.setUTCHours(0, 0, 0, 0)
const rows = await db
  .select({ id: applications.id, company: applications.company, role: applications.role, status: applications.status })
  .from(applications)
  .where(and(
    eq(applications.userId, user.id),
    eq(applications.status, 'needs_review'),
    or(
      gte(applications.queuedAt, start),
      inArray(applications.company, ['Harvey', 'Cursor', 'Scale AI', 'Mercor', 'Match Group']),
    ),
  ))
  .orderBy(desc(applications.queuedAt))
const results = []
for (const row of rows) {
  try {
    await retryApplication(user.id, row.id, { confirmedNotSubmitted: true })
    results.push({ ...row, retried: true })
  } catch (error) {
    results.push({ ...row, retried: false, error: error instanceof Error ? error.message : String(error) })
  }
}
console.log(JSON.stringify({ count: rows.length, results }, null, 2))
await closeDatabase()
