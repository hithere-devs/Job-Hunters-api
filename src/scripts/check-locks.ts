import { getRedis, closeRedis } from '../lib/redis.js'

async function main() {
  const redis = getRedis()
  const t = Date.now()
  const pong = await Promise.race([
    redis.ping(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 5000)),
  ])
  const userId = '1d4f5036-09a1-4df5-8509-e3ac99626b80'
  const keys = await redis.keys(`huntly:*${userId}*`)
  const values: Record<string, string | null> = {}
  for (const key of keys) values[key] = await redis.get(key)
  console.log(JSON.stringify({ pong, ms: Date.now() - t, keys, values }, null, 2))
}

main().finally(async () => { await closeRedis() })
