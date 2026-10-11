import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Redis } from 'ioredis'
import { eq } from 'drizzle-orm'
import { env, hasRedis } from '../../config/env.js'
import { db } from '../../db/client.js'
import { userBrowserSessions } from '../../db/schema.js'
import { logger } from '../../lib/logger.js'

/**
 * Token-owned Redis leases that renew for as long as the work runs.
 *
 * Lanes keep two applications from driving one signed-in profile, cap how many
 * run per user, and let a short task (reading an emailed code) borrow a
 * profile without racing a running application.
 */

let connection: Redis | undefined
function redis(): Redis {
  if (!hasRedis || !env.REDIS_URL) throw new Error('REDIS_URL is required for application lanes.')
  connection ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, enableOfflineQueue: false })
  return connection
}

const TTL_MS = 120_000

export async function acquireLane(key: string, onLost: () => void): Promise<(() => Promise<void>) | null> {
  const token = crypto.randomUUID()
  if (await redis().set(key, token, 'PX', TTL_MS, 'NX') !== 'OK') return null
  const timer = setInterval(() => {
    void Promise.race([
      redis().eval('if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("pexpire",KEYS[1],ARGV[2]) else return 0 end', 1, key, token, TTL_MS),
      sleep(5_000).then(() => { throw new Error('Application lease renewal timed out') }),
    ])
      .then((result) => { if (result !== 1) { logger.error({ key }, 'application lane ownership lost'); onLost() } })
      .catch((error) => { logger.error({ err: error, key }, 'application lane renewal failed'); onLost() })
  }, 20_000)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await redis().eval('if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end', 1, key, token).catch(() => undefined)
  }
}

export function profileLaneKey(vmId: string, tenantIndex: number): string {
  return `huntly:apply-profile:${vmId}:${tenantIndex}`
}

export async function profileLaneHeld(vmId: string, tenantIndex: number): Promise<boolean> {
  return (await redis().exists(profileLaneKey(vmId, tenantIndex))) === 1
}

/**
 * Run `work` while holding the user's profile lease, waiting up to `waitMs`
 * for it. Null when the profile is unavailable (none, or busy throughout).
 */
export async function withProfileLane<T>(userId: string, work: () => Promise<T>, waitMs = 60_000): Promise<T | null> {
  const [session] = await db.select({ vmId: userBrowserSessions.vmId, tenantIndex: userBrowserSessions.tenantIndex }).from(userBrowserSessions).where(eq(userBrowserSessions.userId, userId)).limit(1)
  if (!session) return null
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const release = await acquireLane(profileLaneKey(session.vmId, session.tenantIndex), () => undefined)
    if (release) {
      try { return await work() } finally { await release() }
    }
    await sleep(3_000)
  }
  return null
}

export async function closeLanes(): Promise<void> {
  if (connection) await connection.quit().catch(() => undefined)
  connection = undefined
}
