import { and, eq } from 'drizzle-orm'
import { getTenantStatus, stopTenant } from '../browser/vm-client.js'
import { db, closeDatabase } from '../db/client.js'
import { userBrowserSessions } from '../db/schema.js'
import { getRedis, closeRedis } from '../lib/redis.js'

const userId = '1d4f5036-09a1-4df5-8509-e3ac99626b80'

async function main() {
  const redis = getRedis()
  const [session] = await db.select().from(userBrowserSessions).where(eq(userBrowserSessions.userId, userId)).limit(1)
  if (!session) throw new Error('no browser session')
  const profileKey = `huntly:apply-profile:${session.vmId}:${session.tenantIndex}`
  const userKeys = await Promise.all([0, 1, 2, 3].map((slot) => redis.get(`huntly:apply-user:${userId}:${slot}`)))
  const profile = await redis.get(profileKey)
  const status = await getTenantStatus(session.tenantIndex)
  console.log(JSON.stringify({
    tenantIndex: session.tenantIndex,
    profileHeld: Boolean(profile),
    userSlotsHeld: userKeys.filter(Boolean).length,
    mode: status.mode,
    pid: status.pid,
    uptimeMs: status.uptimeMs,
  }))
  if (profile) {
    console.log(JSON.stringify({ stopped: false, reason: 'live apply-profile lane' }))
    return
  }
  if (status.mode !== 'apply') {
    console.log(JSON.stringify({ stopped: false, reason: `mode ${status.mode}` }))
    return
  }
  const result = await stopTenant(session.tenantIndex)
  const after = await getTenantStatus(session.tenantIndex)
  console.log(JSON.stringify({ stopped: result.stopped, after: after.mode, pid: after.pid }))
}

main().finally(async () => { await closeRedis(); await closeDatabase() })
