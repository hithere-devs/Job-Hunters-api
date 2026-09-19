import { Queue } from 'bullmq'
import { env } from '../config/env.js'
import { dispatchPendingApplications, closeApplicationQueue } from '../hunt/application-queue.js'
import { closeRedis } from '../lib/redis.js'

const queued = await dispatchPendingApplications()
const queue = new Queue(env.APPLICATION_QUEUE_NAME, { connection: { url: env.REDIS_URL } })
const delayed = await queue.getDelayed()
const waiting = await queue.getWaiting()
const active = await queue.getActive()
const promoted = []
for (const job of delayed) {
  await job.promote()
  promoted.push(job.id)
}
console.log(JSON.stringify({
  dispatched: queued,
  waiting: waiting.length,
  active: active.length,
  delayed: delayed.length,
  promoted,
}, null, 2))
await queue.close()
await closeApplicationQueue()
await closeRedis()
