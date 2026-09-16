import { Redis } from 'ioredis'
import { env } from '../../config/env.js'
import { serviceUnavailable } from '../../lib/errors.js'
import { hashToken } from '../../lib/jwt.js'

/** Shared, expiring, one-use OAuth state; never tied to an API process lifetime. */
async function withStateStore<T>(work: (redis: Redis) => Promise<T>): Promise<T> {
  if (!env.REDIS_URL) throw serviceUnavailable('Google sign-in requires the shared session store.')
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 5_000, commandTimeout: 5_000, retryStrategy: () => null })
  redis.on('error', () => undefined)
  try {
    await redis.connect()
    return await work(redis)
  } catch {
    throw serviceUnavailable('Google sign-in is temporarily unavailable. Please try again.')
  } finally {
    redis.disconnect()
  }
}

export async function saveGoogleState(state: string): Promise<void> {
  await withStateStore(async (redis) => { await redis.set(`huntly:oauth:google:${hashToken(state)}`, '1', 'EX', 600, 'NX') })
}

export async function consumeGoogleState(state: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(state)) return false
  return withStateStore(async (redis) => Number(await redis.eval("local v=redis.call('GET',KEYS[1]); if not v then return 0 end; redis.call('DEL',KEYS[1]); return 1", 1, `huntly:oauth:google:${hashToken(state)}`)) === 1)
}
