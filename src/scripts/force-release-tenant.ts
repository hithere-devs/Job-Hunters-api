import { stopTenant, getTenantStatus } from '../browser/vm-client.js'
import { getRedis, closeRedis } from '../lib/redis.js'
import { closeDatabase, db } from '../db/client.js'
import { userBrowserSessions } from '../db/schema.js'
import { eq } from 'drizzle-orm'

const userId = '1d4f5036-09a1-4df5-8509-e3ac99626b80'
const [session] = await db.select().from(userBrowserSessions).where(eq(userBrowserSessions.userId, userId)).limit(1)
if (!session) throw new Error('no session')
const before = await getTenantStatus(session.tenantIndex)
const stopped = await stopTenant(session.tenantIndex)
const redis = getRedis()
const keys = [
  `huntly:apply-profile:${session.vmId}:${session.tenantIndex}`,
  `huntly:apply-user:${userId}:0`,
  `huntly:apply-user:${userId}:1`,
  `huntly:apply-lock:${userId}:ashby`,
  `huntly:apply-lock:${userId}:greenhouse`,
  `huntly:apply-lock:${userId}:lever`,
]
const deleted = await redis.del(...keys)
const after = await getTenantStatus(session.tenantIndex)
console.log(JSON.stringify({
  tenantIndex: session.tenantIndex,
  before: { mode: before.mode, pid: before.pid, uptimeMs: before.uptimeMs },
  stopped,
  deletedKeys: deleted,
  after: { mode: after.mode, pid: after.pid },
}))
await closeRedis()
await closeDatabase()
