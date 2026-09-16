import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectGuardBrowser } from './runtime.mjs'
import { decide } from './guard.mjs'
const policy={attemptId:'fixture',targetId:'raw-target',allowedHosts:['example.com'],approvedFields:[],deadlineEpoch:Date.now()+60000}
function setup(){
 const port=27801, token='fixture-only-internal-token',profileName='extension-test'
 const profile={name:profileName,driver:'extension',cdpPort:port,cdpUrl:`http://openclaw-internal:${token}@127.0.0.1:${port}`}
 const state={resolved:{extensionRelayInternalTokens:{[profileName]:token}},extensionRelays:new Map([[profileName,{port,ownership:'owned',internalToken:token}]]),profiles:new Map([[profileName,{profile}]])}
 const rawPage={id:'raw-page'},calls=[]
 let detached=false,reportedTarget='raw-target'
 const refPage={id:'relay-page',context:()=>({newCDPSession:async()=>({send:async()=>({targetInfo:{targetId:reportedTarget,type:'page'}}),detach:async()=>{detached=true}})})}
 const api={getBrowserControlState:()=>state,resolveProfile:()=>profile}
 const runtime={pageForTarget:async(opts)=>{calls.push(opts);return opts.cdpUrl.includes(':9209')?rawPage:refPage},extensionApi:async()=>api}
 return{runtime,profile,state,api,calls,rawPage,refPage,get detached(){return detached},set reportedTarget(value){reportedTarget=value}}
}
test('default raw profile never reads extension runtime',async()=>{
 const f=setup();f.runtime.extensionApi=async()=>{throw Error('must not inspect extension')}
 const route=await selectGuardBrowser({runtime:f.runtime,policy,tenant:9,action:'act'})
 assert.equal(route.profileName,'tenant');assert.equal(route.refPage,f.rawPage);assert.equal(f.calls.length,1)
 assert.equal(f.calls[0].cdpUrl,'http://127.0.0.1:9209')
})
test('unstarted extension permits only readonly initial snapshot bootstrap',async()=>{
 const f=setup();f.api.getBrowserControlState=()=>null
 const route=await selectGuardBrowser({runtime:f.runtime,policy,tenant:9,profileName:'extension-test',expectedPort:27801,action:'snapshot'})
 assert.equal(route.bootstrap,true);assert.equal(route.refPage,null);assert.equal(route.rawPage,f.rawPage)
 for(const action of ['act','upload','screenshot'])await assert.rejects(selectGuardBrowser({runtime:f.runtime,policy,tenant:9,profileName:'extension-test',expectedPort:27801,action}),/extension_runtime_not_ready/)
 assert.equal(f.calls.every(call=>call.cdpUrl==='http://127.0.0.1:9209'),true)
})
test('active extension uses its own native refs only after exact physical target proof',async()=>{
 const f=setup(),route=await selectGuardBrowser({runtime:f.runtime,policy,tenant:9,profileName:'extension-test',expectedPort:27801,action:'act'})
 assert.equal(route.rawPage,f.rawPage);assert.equal(route.refPage,f.refPage);assert.equal(route.profileName,'extension-test');assert.equal(f.detached,true)
 assert.equal(f.calls[1].targetId,policy.targetId);assert.equal(route.cdpUrl,f.profile.cdpUrl)
 assert.equal(Object.keys(route).includes('cdpUrl'),false)
})
test('wrong physical target rejects even a correctly authenticated loopback extension',async()=>{
 const f=setup();f.reportedTarget='other-tenant-target'
 await assert.rejects(selectGuardBrowser({runtime:f.runtime,policy,tenant:9,profileName:'extension-test',expectedPort:27801,action:'act'}),/extension_target_mismatch/)
 assert.equal(f.detached,true)
})
test('wrong relay port or stale authentication never receives bootstrap fallback',async()=>{
 const f=setup();f.profile.cdpPort=20801
 await assert.rejects(selectGuardBrowser({runtime:f.runtime,policy,tenant:9,profileName:'extension-test',expectedPort:27801,action:'snapshot'}),/extension_runtime_not_ready/)
 assert.equal(f.calls.length,1)
})
test('profile routing remains explicitly pinned without relaxing submit policy',async()=>{
 const facts={targetId:policy.targetId,url:'https://example.com',frameUrls:[],hasAuthentication:false}
 const profileName='extension-test'
 const good=await decide({toolName:'browser',params:{action:'snapshot',profile:profileName}},policy,facts,async()=>null,Date.now(),{profileName})
 assert.equal(good.params.profile,profileName)
 assert.equal((await decide({toolName:'browser',params:{action:'snapshot',profile:'tenant'}},policy,facts,async()=>null,Date.now(),{profileName})).block,true)
 const submit=await decide({toolName:'browser',params:{action:'act',profile:profileName,request:{kind:'click',ref:'e1'}}},policy,facts,async()=>({tag:'button',type:'submit',name:'Submit application',label:'Submit application',visible:true}),Date.now(),{profileName})
 assert.equal(submit.block,true)
})
