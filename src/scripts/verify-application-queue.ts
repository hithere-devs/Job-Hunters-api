/** Isolated DB/Redis integration fixture. Never starts a consumer or opens a browser. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { and, count, eq, inArray } from 'drizzle-orm'
import { env } from '../config/env.js'
import { db, closeDatabase } from '../db/client.js'
import { users,jobs,huntRuns,huntRunJobs,huntCandidates,huntSpecs,applications,applicationDispatches,applyAttempts } from '../db/schema.js'
import { enqueueApprovedCandidates,dispatchPendingApplications,closeApplicationQueue } from '../hunt/application-queue.js'
import { cancelApplication,retryApplication,flagApplication } from '../modules/applications/actions.js'
import { closeRedis } from '../lib/redis.js'

if(!env.APPLICATION_QUEUE_NAME.startsWith('hunt-apply-test-'))throw new Error('Set APPLICATION_QUEUE_NAME=hunt-apply-test-<unique>; production queues are forbidden.')
if(!env.APPLY_DRY_RUN)throw new Error('Fixture requires APPLY_DRY_RUN=true')
const redis=new Redis(env.REDIS_URL!,{maxRetriesPerRequest:null})
const queue=new Queue(env.APPLICATION_QUEUE_NAME,{connection:redis})
assert.equal(await queue.getWorkersCount(),0,'Fixture queue must have no consumers')
await queue.pause()
const userId=crypto.randomUUID(), otherUserId=crypto.randomUUID(), jobIds:string[]=[]
try {
 await db.insert(users).values([{id:userId,email:`queue-fixture-${userId}@example.invalid`,name:'Queue fixture',passwordHash:'!disabled-fixture'},{id:otherUserId,email:`queue-fixture-${otherUserId}@example.invalid`,name:'Other fixture',passwordHash:'!disabled-fixture'}])
 await db.insert(huntSpecs).values({userId,dailyTarget:2})
 const runs=await db.insert(huntRuns).values([{userId,status:'completed',targetApplications:2},{userId,status:'completed',targetApplications:2}]).returning()
 for(let i=0;i<3;i++)jobIds.push(crypto.randomUUID())
 await db.insert(jobs).values(jobIds.map((id,i)=>({id,fingerprint:`fixture-${id}`,title:`Fixture ${i}`,company:'Fixture only',locations:[],canonicalUrl:`https://fixture.invalid/jobs/${id}`,applyUrl:`https://fixture.invalid/apply/${id}`,postedAt:new Date(),postedAtPrecision:'day'})))
 const candidates=await db.insert(huntCandidates).values(jobIds.map((jobId,i)=>({userId,jobId,runId:runs[i===2?1:0]!.id,sourcePortal:'greenhouse',score:99,scoreBreakdown:{},status:'discovered' as const}))).returning()
 await db.insert(huntRunJobs).values(candidates.map(c=>({userId,jobId:c.jobId,runId:c.runId,sourcePortal:'greenhouse',status:'eligible' as const})))
 const first=await enqueueApprovedCandidates(userId,runs[0]!.id,candidates.slice(0,2).map(c=>c.id))
 assert.equal(first.queued,2)
 const cap=await enqueueApprovedCandidates(userId,runs[1]!.id,[candidates[2]!.id]);assert.equal(cap.queued,0);assert.equal(cap.capped,true)
 console.log('PASS atomic daily budget shared across hunts; 2 allowed, third capped')
 const duplicate=await enqueueApprovedCandidates(userId,runs[0]!.id,candidates.slice(0,2).map(c=>c.id));assert.equal(duplicate.queued,0)
 const before=await queue.count();await dispatchPendingApplications();const after=await queue.count();assert.deepEqual(before,after)
 console.log('PASS repeated enqueue and repeated dispatch do not duplicate jobs')
 const apps=await db.select().from(applications).where(eq(applications.userId,userId));assert.equal(apps.length,2)
 const app=apps.find(a=>a.jobId===candidates[0]!.jobId)!
 await assert.rejects(cancelApplication(otherUserId,app.id),/not found/)
 await cancelApplication(userId,app.id)
 assert.equal((await db.select().from(applications).where(eq(applications.id,app.id)))[0]!.status,'closed')
 await retryApplication(userId,app.id)
 console.log('PASS cross-user cancellation rejected; waiting cancel and explicit safe retry persist')
 const [dispatch]=await db.select().from(applicationDispatches).where(and(eq(applicationDispatches.candidateId,candidates[0]!.id),eq(applicationDispatches.userId,userId))).orderBy(applicationDispatches.createdAt)
 const allDispatches=await db.select().from(applicationDispatches).where(eq(applicationDispatches.candidateId,candidates[0]!.id));const latest=allDispatches.find(d=>!d.cancelledAt)!
 await (await queue.getJob(`dispatch-${latest.id}`))!.remove();await dispatchPendingApplications();assert.ok(await queue.getJob(`dispatch-${latest.id}`))
 console.log('PASS missing never-started Redis job restored from durable DB dispatch')
 const uncertain=apps.find(a=>a.jobId===candidates[1]!.jobId)!
 await db.update(applications).set({status:'needs_review'}).where(eq(applications.id,uncertain.id))
 await db.insert(applyAttempts).values({userId,candidateId:candidates[1]!.id,portalId:'greenhouse',status:'failed',submitStartedAt:new Date()})
 await assert.rejects(retryApplication(userId,uncertain.id),/submit was attempted/)
 await flagApplication(userId,uncertain.id,'Fixture flag')
 console.log('PASS durable submit fence rejects retry even with no event telemetry; flag is durable')
} finally {
 await db.delete(users).where(inArray(users.id,[userId,otherUserId]))
 if(jobIds.length)await db.delete(jobs).where(inArray(jobs.id,jobIds))
 await queue.obliterate({force:true});await queue.close();await redis.quit();await closeApplicationQueue();await closeRedis();await closeDatabase()
 console.log('Fixture users, jobs, and isolated Redis queue removed; no consumer or browser started')
}
