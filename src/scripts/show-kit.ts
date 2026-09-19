import { eq } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { kits, userBrowserSessions, users } from '../db/schema.js'

const email = process.argv[2] ?? 'mywritingfrenzy@gmail.com'
const [user] = await db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(eq(users.email, email)).limit(1)
if (!user) {
  console.log('no user')
  await closeDatabase()
  process.exit(1)
}
const [kit] = await db.select().from(kits).where(eq(kits.userId, user.id)).limit(1)
const sessions = await db.select().from(userBrowserSessions).where(eq(userBrowserSessions.userId, user.id))
console.log(JSON.stringify({
  user,
  kit: kit && {
    fullName: kit.fullName,
    email: kit.email,
    phone: kit.phone,
    city: kit.city,
    country: kit.country,
    linkedinUrl: kit.linkedinUrl,
    githubUrl: kit.githubUrl,
    portfolioUrl: kit.portfolioUrl,
    workAuthorization: kit.workAuthorization,
    headline: kit.headline,
  },
  sessions: sessions.map((row) => ({
    vmId: row.vmId,
    tenantIndex: row.tenantIndex,
    status: row.status,
    updatedAt: row.updatedAt,
  })),
}, null, 2))
await closeDatabase()
