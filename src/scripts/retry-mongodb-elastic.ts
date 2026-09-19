import { retryApplication } from '../modules/applications/actions.js'
import { closeApplicationQueue } from '../hunt/application-queue.js'
import { closeDatabase } from '../db/client.js'
import { closeRedis } from '../lib/redis.js'

const userId = '1d4f5036-09a1-4df5-8509-e3ac99626b80'
const jobs = [
  { id: '1be3def6-6a3f-4a53-a8f6-7243b70419f3', company: 'MongoDB' },
  { id: '38db9f06-fdc3-4134-93aa-a4a856daa45c', company: 'Elastic' },
]

async function main() {
  for (const job of jobs) {
    try {
      const result = await retryApplication(userId, job.id)
      console.log(JSON.stringify({ company: job.company, result }))
    } catch (error) {
      console.log(JSON.stringify({ company: job.company, error: error instanceof Error ? error.message : String(error) }))
    }
  }
}

main().finally(async () => {
  await closeApplicationQueue()
  await closeRedis()
  await closeDatabase()
})
