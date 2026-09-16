/** Isolated integration fixture. No provider login, queue execution, or submission. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { eq } from 'drizzle-orm'
import { chromium } from 'playwright-core'
import WebSocket from 'ws'
import { db, closeDatabase } from '../src/db/client.js'
import { users, huntRuns, jobs, huntCandidates, applyAttempts, attemptEvents, applications } from '../src/db/schema.js'
import { attachLiveGateway } from '../src/live/gateway.js'
import { signAccessToken } from '../src/lib/jwt.js'
import { getRedis, closeRedis } from '../src/lib/redis.js'
import { closeApplicationQueue } from '../src/hunt/application-queue.js'
import { closeAttemptEvents } from '../src/hunt/apply/events.js'
import { startScreencast } from '../src/hunt/apply/screencast.js'
import { reconcileApplicationRecords } from '../src/modules/applications/runtime.js'

const userId=randomUUID(), attemptId=randomUUID(), email=`watch-fixture-${userId}@example.invalid`
const server=createServer(); const gateway=attachLiveGateway(server)
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined
let stream:Awaited<ReturnType<typeof startScreencast>>|undefined
let watcher:WebSocket|undefined
const controls=getRedis().duplicate()
try {
  await db.insert(users).values({id:userId,email,name:'Isolated watch fixture',passwordHash:'!disabled-test-account',onboarded:true})
  const [job]=await db.select({id:jobs.id}).from(jobs).limit(1);assert(job)
  const [run]=await db.insert(huntRuns).values({userId,status:'applying',targetApplications:1}).returning();assert(run)
  const [candidate]=await db.insert(huntCandidates).values({userId,runId:run.id,jobId:job.id,sourcePortal:'greenhouse',score:80,scoreBreakdown:{},status:'queued',updatedAt:new Date(Date.now()-600000)}).returning();assert(candidate)
  assert.equal(await reconcileApplicationRecords(userId),1)
  assert.equal(await reconcileApplicationRecords(userId),0)
  const [recovered]=await db.select().from(applications).where(eq(applications.userId,userId))
  assert.equal(recovered?.status,'needs_review')
  console.log('PASS missing application record recovered once; missing queue entry marked for review; no retry')
  await db.insert(applyAttempts).values({id:attemptId,userId,candidateId:candidate.id,portalId:'greenhouse',status:'submitting',startedAt:new Date()})
  await db.insert(attemptEvents).values({attemptId,state:'filling'})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const address=server.address();assert(address && typeof address!=='string')
  const url=`ws://127.0.0.1:${address.port}/live/${attemptId}/watch`
  const rejected=async(token:string)=>new Promise<void>((resolve,reject)=>{
    const ws=new WebSocket(`${url}?token=${encodeURIComponent(token)}`)
    ws.once('open',()=>{ws.close();reject(new Error('Unauthorized socket was accepted'))})
    ws.once('error',()=>resolve());ws.once('unexpected-response',(_req,res)=>{res.resume();resolve()})
  })
  await rejected('');await rejected(signAccessToken({userId:randomUUID(),email:'other@example.invalid'}))
  console.log('PASS watch WebSocket rejects missing auth and another user before accepting')
  let forwarded=0
  await controls.subscribe(`huntly:takeover:${attemptId}`)
  controls.on('message',()=>{forwarded++})
  const received:Array<{type:string;state?:string;data?:string}>=[]
  watcher=new WebSocket(`${url}?token=${encodeURIComponent(signAccessToken({userId,email}))}`)
  watcher.on('message',raw=>received.push(JSON.parse(String(raw))))
  await once(watcher,'open')
  for(const kind of ['click','key','scroll','release']) watcher.send(JSON.stringify({kind,x:10,y:10,text:'fixture',deltaY:50}))
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
  const page=await browser.newPage()
  await page.setContent('<html><body><h1>Read-only application watch fixture</h1><p>No real application is being submitted.</p><input aria-label="Fixture field" value="Sample resume details" /></body></html>')
  stream=await startScreencast({page,userId,attemptId})
  const deadline=Date.now()+12000
  while(Date.now()<deadline && !received.some(e=>e.type==='frame')) await sleep(100)
  assert(received.some(e=>e.type==='frame' && e.data && e.data.length>100))
  assert(received.some(e=>e.type==='state' && e.state==='filling'))
  assert.equal(forwarded,0)
  await writeFile('/tmp/huntly-watch-fixture.jpg', Buffer.from(received.find(e=>e.type==='frame')!.data!, 'base64'))
  console.log('PASS live Chrome JPEG relayed through authenticated read-only WebSocket')
  console.log('PASS late watcher receives current state; forged clicks/keys/scroll/release never reach control channel')
} finally {
  watcher?.close();for(const client of gateway.clients) client.terminate()
  await stream?.stop();await browser?.close();gateway.close();server.close()
  await controls.quit();await closeAttemptEvents();await closeApplicationQueue()
  await db.delete(users).where(eq(users.id,userId))
  await getRedis().del(`huntly:watching:${attemptId}`)
  await closeRedis();await closeDatabase()
}
