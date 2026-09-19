import { Queue } from 'bullmq'
import { env } from '../config/env.js'
import { closeRedis } from '../lib/redis.js'

const queue = new Queue(env.APPLICATION_QUEUE_NAME, { connection: { url: env.REDIS_URL } })
const active = await queue.getActive()
const out = []
for (const job of active) {
  const age = job.processedOn ? Date.now() - job.processedOn : null
  try {
    await job.moveToFailed(new Error('stale active job after runner restart'), '0', false)
    out.push({ id: job.id, candidateId: job.data?.candidateId, age, failed: true })
  } catch (error) {
    out.push({ id: job.id, candidateId: job.data?.candidateId, age, error: error instanceof Error ? error.message : String(error) })
  }
}
const delayed = await queue.getDelayed()
for (const job of delayed) {
  await job.promote()
}
console.log(JSON.stringify({
  failedActive: out,
  waiting: (await queue.getWaiting()).length,
  active: (await queue.getActive()).length,
  delayed: (await queue.getDelayed()).length,
}, null, 2))
await queue.close()
await closeRedis()
