import { env, hasRedis } from './config/env.js'
import { startApplicationWorker, closeApplicationQueue } from './hunt/application-queue.js'
import { closeDatabase } from './db/client.js'
import { closeAttemptEvents } from './hunt/apply/events.js'
import { closeRedis } from './lib/redis.js'
import { logger } from './lib/logger.js'

/** The VM's runner process. LinkedIn/outreach workers deliberately stay off it. */
if (!hasRedis || !env.PORTAL_AUTOMATION_ENABLED) throw new Error('VM application runner requires Redis and PORTAL_AUTOMATION_ENABLED=true')
const worker = startApplicationWorker()
logger.info({dryRun:env.APPLY_DRY_RUN,browserProvider:env.BROWSER_PROVIDER,applyDriver:env.APPLY_DRIVER,queue:env.APPLICATION_QUEUE_NAME},'VM application runner started; this process fills ATS forms')
let stopping=false
async function shutdown(signal:string) {
  if(stopping)return;stopping=true
  logger.info({signal},'Stopping acceptance of application jobs; waiting for active work')
  const deadline=setTimeout(()=>{logger.fatal('Runner graceful shutdown timed out; active attempts require reconciliation');process.exit(1)},11*60_000)
  deadline.unref()
  try {
    await worker.pause(true)
    await closeApplicationQueue()
    await closeAttemptEvents()
    await closeRedis()
    await closeDatabase()
    clearTimeout(deadline);process.exit(0)
  } catch(error) { logger.error({err:error},'Runner shutdown failed');process.exit(1) }
}
process.on('SIGTERM',()=>void shutdown('SIGTERM'))
process.on('SIGINT',()=>void shutdown('SIGINT'))
process.on('uncaughtException',error=>{logger.fatal({err:error},'Runner uncaught exception');void shutdown('uncaughtException')})
process.on('unhandledRejection',error=>{logger.fatal({err:error},'Runner unhandled rejection');void shutdown('unhandledRejection')})
