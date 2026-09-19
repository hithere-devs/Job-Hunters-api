import { retryApplication } from '../modules/applications/actions.js'
import { closeApplicationQueue } from '../hunt/application-queue.js'
import { closeDatabase } from '../db/client.js'
import { closeRedis } from '../lib/redis.js'

async function main() {
  const userId = '1d4f5036-09a1-4df5-8509-e3ac99626b80'
  try {
    console.log(JSON.stringify(await retryApplication(userId, '77e7c3d2-1b36-489f-85c1-6b936aee58b9')))
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error))
  }
}

main().finally(async () => {
  await closeApplicationQueue()
  await closeRedis()
  await closeDatabase()
})
