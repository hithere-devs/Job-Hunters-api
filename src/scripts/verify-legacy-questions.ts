/** Isolated metadata repair and shared-answer fixture. No browser or consumer. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { and,eq,inArray } from 'drizzle-orm'
import { db,closeDatabase } from '../db/client.js'
import { users,jobs,huntRuns,huntCandidates,applications,applyAttempts,pendingApplicationQuestions,kits } from '../db/schema.js'
import { listQuestionInbox,answerQuestions } from '../modules/applications/questions.js'
import { closeApplicationQueue } from '../hunt/application-queue.js'
import { closeRedis } from '../lib/redis.js'
import { env } from '../config/env.js'
if(!env.APPLICATION_QUEUE_NAME.startsWith('hunt-apply-test-'))throw new Error('Use an isolated test queue.')
const connection=new Redis(env.REDIS_URL!,{maxRetriesPerRequest:null}),queue=new Queue(env.APPLICATION_QUEUE_NAME,{connection})
assert.equal(await queue.getWorkersCount(),0);await queue.pause()
const userId=crypto.randomUUID(),jobIds:string[]=[]
try{
 await db.insert(users).values({id:userId,email:`legacy-${userId}@example.invalid`,name:'Legacy fixture',passwordHash:'!disabled-fixture'})
 const [run]=await db.insert(huntRuns).values({userId,status:'completed',targetApplications:10}).returning()
 const questionIds:string[]=[]
 let firstApp='',firstAttempt=''
 for(const [i,label] of ['LinkedIn URL','LinkedIn Profile','LinkedIn Profile - no fact provided'].entries()){
  const id=crypto.randomUUID();jobIds.push(id)
  await db.insert(jobs).values({id,fingerprint:`fixture-${id}`,title:'Fixture role',company:'Fixture only',locations:[],canonicalUrl:`https://fixture${i}.invalid/apply`,postedAt:new Date(),postedAtPrecision:'day'})
  const [candidate]=await db.insert(huntCandidates).values({userId,runId:run!.id,jobId:id,sourcePortal:'greenhouse',status:'needs_review',score:99,scoreBreakdown:{}}).returning()
  const [app]=await db.insert(applications).values({userId,jobId:id,huntRunId:run!.id,role:'Fixture role',company:'Fixture only',jobUrl:`https://fixture${i}.invalid/apply`,status:'needs_review'}).returning()
  const [attempt]=await db.insert(applyAttempts).values({userId,candidateId:candidate!.id,portalId:'greenhouse',status:'needs_review'}).returning()
  const [question]=await db.insert(pendingApplicationQuestions).values({userId,applicationId:app!.id,attemptId:attempt!.id,host:`fixture${i}.invalid`,fieldSignature:crypto.randomUUID(),label,type:'text',required:true,status:'expired',expiresAt:new Date()}).returning()
  questionIds.push(question!.id);if(i===0){firstApp=app!.id;firstAttempt=attempt!.id}
 }
 const base={userId,applicationId:firstApp,attemptId:firstAttempt,host:'fixture0.invalid',type:'text',required:true,expiresAt:new Date()}
 const [unanswered]=await db.insert(pendingApplicationQuestions).values({...base,fieldSignature:crypto.randomUUID(),label:'Gender',sensitive:true,status:'expired'}).returning()
 const [answered]=await db.insert(pendingApplicationQuestions).values({...base,fieldSignature:crypto.randomUUID(),label:'Race',sensitive:true,status:'answered',answer:'Fixture-only previously saved answer'}).returning()
 const [live]=await db.insert(pendingApplicationQuestions).values({...base,fieldSignature:crypto.randomUUID(),fieldName:'office',label:'Preferred office',type:'radio',options:['London','Bengaluru'],status:'pending',expiresAt:new Date(Date.now()+600_000)}).returning()
 const inbox=await listQuestionInbox(userId)
 const linkedin=inbox.groups.filter(g=>g.label==='LinkedIn profile URL')
 assert.equal(linkedin.length,1);assert.equal(linkedin[0]!.questions.length,3);assert.equal(linkedin[0]!.required,false)
 assert.equal(inbox.groups.some(g=>['Gender','Race'].includes(g.label)),false)
 assert.equal(inbox.blockedApplications.every(app=>app.canRecoverQuestions),true)
 const qrows=await db.select().from(pendingApplicationQuestions).where(inArray(pendingApplicationQuestions.id,[unanswered!.id,answered!.id,live!.id]))
 assert.equal(qrows.find(q=>q.id===unanswered!.id)!.required,false)
 assert.equal(qrows.find(q=>q.id===unanswered!.id)!.blockedReason,'legacy_metadata')
 assert.equal(qrows.find(q=>q.id===answered!.id)!.answer,'Fixture-only previously saved answer')
 assert.equal(qrows.find(q=>q.id===answered!.id)!.required,true)
 assert.equal(qrows.find(q=>q.id===live!.id)!.status,'pending')
 assert.equal(qrows.find(q=>q.id===live!.id)!.required,true)
 console.log('PASS incomplete legacy demographics hidden; only unanswered legacy metadata repaired; saved/live rows unchanged')
 console.log('PASS three LinkedIn aliases across providers form one shared optional profile question')
 const value='https://www.linkedin.com/in/fixture-user'
 const saved=await answerQuestions(userId,questionIds.map(questionId=>({questionId,answer:value,remember:true,skip:false})))
 assert.equal(saved.queuedApplicationIds.length,0)
 assert.equal((await db.select().from(kits).where(eq(kits.userId,userId)))[0]!.linkedinUrl,value)
 await assert.rejects(answerQuestions(userId,[{questionId:questionIds[0]!,answer:'not a URL',remember:true,skip:false}]),/valid|URL|answer|Invalid/i)
 assert.equal((await db.select().from(pendingApplicationQuestions).where(eq(pendingApplicationQuestions.id,questionIds[0]!)))[0]!.answer,value)
 console.log('PASS explicit remember updates My Kit once; invalid profile value rolls back; no uncaptured application autoqueued')
}finally{
 await queue.obliterate({force:true});await queue.close();await connection.quit();await db.delete(users).where(eq(users.id,userId));if(jobIds.length)await db.delete(jobs).where(inArray(jobs.id,jobIds));await closeApplicationQueue();await closeRedis();await closeDatabase()
 console.log('Fixture records and isolated queue removed; no live user answers changed')
}
