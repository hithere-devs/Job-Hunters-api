import { Queue } from 'bullmq'
import { env } from '../config/env.js'
import { closeRedis } from '../lib/redis.js'

const queue = new Queue(env.APPLICATION_QUEUE_NAME, { connection: { url: env.REDIS_URL } })
const delayed = await queue.getDelayed()
const promoted = []
for (const job of delayed) {
  await job.promote()
  promoted.push({ id: job.id, candidateId: job.data?.candidateId, portal: job.data?.portal })
}
console.log(JSON.stringify({ delayed: delayed.length, promoted }, null, 2))
await queue.close()
await closeRedis()
