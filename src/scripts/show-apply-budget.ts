import { and, count, desc, eq, gte } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { applications, huntRuns, huntSpecs, users } from '../db/schema.js'

const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'mywritingfrenzy@gmail.com')).limit(1)
if (!user) throw new Error('no user')
const [spec] = await db.select().from(huntSpecs).where(eq(huntSpecs.userId, user.id)).limit(1)
const start = new Date()
start.setUTCHours(0, 0, 0, 0)
const [used] = await db.select({ value: count() }).from(applications).where(and(eq(applications.userId, user.id), gte(applications.queuedAt, start)))
const runs = await db
  .select({ id: huntRuns.id, status: huntRuns.status, target: huntRuns.targetApplications, createdAt: huntRuns.createdAt })
  .from(huntRuns)
  .where(eq(huntRuns.userId, user.id))
  .orderBy(desc(huntRuns.createdAt))
  .limit(3)
const recent = await db
  .select({
    id: applications.id,
    status: applications.status,
    company: applications.company,
    role: applications.role,
    queuedAt: applications.queuedAt,
  })
  .from(applications)
  .where(eq(applications.userId, user.id))
  .orderBy(desc(applications.queuedAt))
  .limit(15)
console.log(JSON.stringify({ dailyTarget: spec?.dailyTarget, usedToday: used?.value, runs, recent }, null, 2))
await closeDatabase()
