import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Page } from 'playwright-core'
import { startScreencast } from './screencast.js'

test('a late watcher gets a frame on a static page and stopping ends capture',async()=>{
 let watched=false;let captures=0;const commands:string[]=[];const frames:unknown[]=[]
 const page={context:()=>({newCDPSession:async()=>({on(){},send:async(name:string)=>{commands.push(name)},detach:async()=>{commands.push('detach')}})}),screenshot:async()=>{captures++;return Buffer.from('fixture')}} as unknown as Page
 const stream=await startScreencast({page,userId:'fixture',attemptId:'fixture',watcherCheck:async()=>watched,emit:(_u,e)=>frames.push(e),pollMs:10})
 await sleep(30);assert.equal(captures,0)
 watched=true;await sleep(40);assert(captures>=1);assert(frames.length>=1);assert(commands.includes('Page.startScreencast'))
 await stream.stop();const count=captures;await sleep(25);assert.equal(captures,count);assert(commands.includes('detach'))
})

test('screenshot fallback works without CDP screencast support',async()=>{
 const frames:unknown[]=[]
 const page={context:()=>({newCDPSession:async()=>{throw new Error('unsupported')}}),screenshot:async()=>Buffer.from('fixture')} as unknown as Page
 const stream=await startScreencast({page,userId:'fixture',attemptId:'fixture',watcherCheck:async()=>true,emit:(_u,e)=>frames.push(e),pollMs:10})
 await sleep(30);await stream.stop();assert(frames.length>=1)
})
