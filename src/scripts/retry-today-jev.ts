import { retryApplication } from '../modules/applications/actions.js'
import { closeApplicationQueue } from '../hunt/application-queue.js'
import { closeDatabase } from '../db/client.js'
import { closeRedis } from '../lib/redis.js'

const userId = '1d4f5036-09a1-4df5-8509-e3ac99626b80'
const jobs = [
  { id: '77a60616-9a9f-401e-a108-b033b6e4d34f', company: 'Mercor Marketplace' },
  { id: 'aee06250-730c-42fe-a1b3-712927e7af73', company: 'Flexport' },
  { id: 'e434fd32-dfa1-4568-b739-767218eb2d2a', company: 'Scale AI Staff' },
  { id: 'ac8ee938-7c1a-4291-99bc-8c5038b6e465', company: 'Harvey' },
  { id: '9abd73eb-b210-4dfa-887e-b0e020ff5118', company: 'Reddit Media Player' },
  { id: 'd61ce48b-e77b-4b52-8f3a-3cc43e550e32', company: 'Reddit Ads Creative' },
  { id: '56026832-99fd-4a75-b44d-824f37e2daaa', company: 'Reddit Content Platform' },
]

const results = []
for (const job of jobs) {
  try {
    const result = await retryApplication(userId, job.id, { confirmedNotSubmitted: true })
    results.push({ ...job, result })
  } catch (error) {
    results.push({ ...job, error: error instanceof Error ? error.message : String(error) })
  }
}
console.log(JSON.stringify(results, null, 2))
await closeApplicationQueue()
await closeRedis()
await closeDatabase()
