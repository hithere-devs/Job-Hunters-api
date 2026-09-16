import { db } from '../../db/client.js'
import { and, eq } from 'drizzle-orm'
import { kits, users, applications, huntCandidates, huntRunJobs, huntRuns, applicationDispatches, applicationEvents, jobs } from '../../db/schema.js'
import { dispatchPendingApplications } from '../../hunt/application-queue.js'
import { env } from '../../config/env.js'
async function main(){
  const [u] = await db.select().from(users).where(eq(users.email,'mywritingfrenzy@gmail.com')).limit(1)
  if(!u) throw new Error('no user')
  // The derivation needs a country; the kit only had "Bangalore".
  await db.update(kits).set({country:'India',updatedAt:new Date()}).where(and(eq(kits.userId,u.id)))
  const [k] = await db.select({country:kits.country,city:kits.city}).from(kits).where(eq(kits.userId,u.id)).limit(1)
  console.log('kit:', JSON.stringify(k))

  const [row] = await db.select({appId:applications.id,company:applications.company,role:applications.role,candId:huntCandidates.id,runId:huntCandidates.runId,jobId:huntCandidates.jobId,portal:huntCandidates.sourcePortal,locations:jobs.locations})
    .from(applications)
    .innerJoin(huntCandidates,and(eq(huntCandidates.jobId,applications.jobId),eq(huntCandidates.userId,applications.userId)))
    .innerJoin(jobs,eq(jobs.id,applications.jobId))
    .where(and(eq(applications.userId,u.id),eq(applications.company,'Mercor'),eq(applications.role,'Infrastructure Engineer')))
    .limit(1)
  if(!row){console.log('NOT FOUND');process.exit(1)}
  console.log('target:', row.company, '-', row.role, 'locations:', JSON.stringify(row.locations))
  const now=new Date()
  await db.update(applicationDispatches).set({cancelledAt:now,updatedAt:now}).where(eq(applicationDispatches.candidateId,row.candId))
  await db.insert(applicationDispatches).values({userId:u.id,runId:row.runId,candidateId:row.candId,portal:row.portal,queueName:env.APPLICATION_QUEUE_NAME})
  await db.update(huntCandidates).set({status:'queued',updatedAt:now}).where(eq(huntCandidates.id,row.candId))
  await db.update(huntRunJobs).set({status:'queued',updatedAt:now}).where(and(eq(huntRunJobs.runId,row.runId),eq(huntRunJobs.jobId,row.jobId)))
  await db.update(huntRuns).set({status:'applying',finishedAt:null,stopRequestedAt:null,updatedAt:now}).where(eq(huntRuns.id,row.runId))
  await db.update(applications).set({status:'queued',queuedAt:now,updatedAt:now}).where(eq(applications.id,row.appId))
  await db.insert(applicationEvents).values({applicationId:row.appId,fromStatus:'needs_review',toStatus:'queued',note:'Retry with derived work-authorisation answers.'})
  console.log('DISPATCHED:', await dispatchPendingApplications())
  process.exit(0)
}
void main().catch(e=>{console.error('ERR',(e as Error).message);process.exit(1)})
