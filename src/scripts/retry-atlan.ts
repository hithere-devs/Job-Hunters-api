import { retryApplication } from '../modules/applications/actions.js'
import { closeApplicationQueue } from '../hunt/application-queue.js'
import { closeDatabase } from '../db/client.js'
import { closeRedis } from '../lib/redis.js'

async function main() {
  const userId = '1d4f5036-09a1-4df5-8509-e3ac99626b80'
  try {
    console.log(JSON.stringify(await retryApplication(userId, '06c96dcc-39d3-469c-8f16-09551e91af73', { confirmedNotSubmitted: true })))
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error))
  }
}

main().finally(async () => {
  await closeApplicationQueue()
  await closeRedis()
  await closeDatabase()
})
