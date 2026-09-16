/** VM root-only tenant 9/10 synthetic isolation fixture. Never reads cookie values. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pageFacts, describePage } from './runtime.mjs'
import { decide } from './guard.mjs'
if(process.getuid()!==0)throw new Error('Run on VM as root')
const {chromium}=await import('/opt/huntly/api/node_modules/playwright-core/index.mjs')
const {default:WebSocket}=await import('/opt/huntly/api/node_modules/ws/wrapper.mjs')
const token=(await readFile('/etc/huntly/vm-agent.env','utf8')).split('\n').find(l=>l.startsWith('VM_AGENT_TOKEN=')).slice(15).replace(/^"|"$/g,'')
const registry=JSON.parse(await readFile('/etc/huntly/openclaw-tenants.json','utf8'))
const vm=async(i,action)=>{const r=await fetch(`http://127.0.0.1:18900/tenants/${i}/${action}`,{method:'POST',headers:{Authorization:`Bearer ${token}`}});if(!r.ok)throw new Error(`VM tenant${i} ${action} HTTP ${r.status}`);return r.json()}
const tenants=process.argv.includes('--guard-only')?[9]:[9,10]
const browsers=[],pages=[], markerKey=`huntly-isolation-${randomUUID()}`, marker9='synthetic-tenant-nine',marker10='synthetic-tenant-ten'
try{
 for(const tenant of tenants){
  const info=await vm(tenant,'apply'),browser=await chromium.connectOverCDP(info.cdpUrl)
  browsers.push(browser);const page=await browser.contexts()[0].newPage();pages.push(page)
  await page.goto('https://example.com',{waitUntil:'domcontentloaded',timeout:30000})
 }
 if(tenants.length===2){
 await pages[0].evaluate(({key,value})=>localStorage.setItem(key,value),{key:markerKey,value:marker9})
 assert.equal(await pages[1].evaluate(key=>localStorage.getItem(key),markerKey),null)
 await pages[1].evaluate(({key,value})=>localStorage.setItem(key,value),{key:markerKey,value:marker10})
 assert.equal(await pages[0].evaluate(key=>localStorage.getItem(key),markerKey),marker9)
 assert.equal(await pages[1].evaluate(key=>localStorage.getItem(key),markerKey),marker10)
 console.log('PASS tenant9/10 isolation: distinct CDP profiles retain independent synthetic markers on the same example.com origin.')
 }
 // Native DOM fixture for invisible reCAPTCHA + optional auth affordances.
 await pages[0].route('https://hidden.fixture.invalid/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<p>Hidden synthetic frame</p>'}))
 await pages[0].setContent('<header><button>Sign in</button></header><h1>Application</h1><label>Name<input></label><textarea id="g-recaptcha-response" style="display:none"></textarea><iframe style="display:none" src="https://hidden.fixture.invalid/frame"></iframe>')
 const fact=await pageFacts(pages[0],'fixture-target')
 assert.equal(fact.hasAuthentication,false)
 const p={attemptId:'fixture',targetId:'fixture-target',allowedHosts:['example.com'],approvedFields:[],resumePath:null,deadlineEpoch:Date.now()+60000}
 assert.equal((await decide({toolName:'browser',params:{action:'snapshot'}},p,fact,async()=>{throw new Error('no refs needed')})).block,undefined)
 await pages[0].evaluate(()=>{const challenge=document.createElement('div');challenge.setAttribute('role','checkbox');challenge.setAttribute('aria-label',"I'm not a robot");challenge.textContent="I'm not a robot";document.body.appendChild(challenge)})
 assert.equal((await pages[0].evaluate(describePage)).hasAuthentication,true)
 assert.equal((await decide({toolName:'browser',params:{action:'snapshot'}},p,await pageFacts(pages[0],'fixture-target'),async()=>{throw new Error('no refs needed')})).block,true)
 console.log('PASS native Chrome guard: hidden reCAPTCHA and optional Sign in do not block snapshots; visible human-verification challenge does.')
 assert.notEqual(registry['9'].token,registry['10'].token)
 const rejected=await new Promise((resolve,reject)=>{
  const ws=new WebSocket(`ws://127.0.0.1:${registry['10'].port}`)
  const timer=setTimeout(()=>{ws.terminate();reject(new Error('wrong-token handshake timeout'))},10000)
  ws.on('message',bytes=>{const f=JSON.parse(bytes.toString());if(f.event==='connect.challenge')ws.send(JSON.stringify({type:'req',id:'wrong-tenant-token',method:'connect',params:{minProtocol:4,maxProtocol:4,client:{id:'gateway-client',version:'fixture',platform:'linux',mode:'backend'},caps:[],role:'operator',scopes:['operator.read'],auth:{token:registry['9'].token}}}));if(f.type==='res'&&f.id==='wrong-tenant-token'){clearTimeout(timer);resolve(f);ws.close()}})
  ws.on('error',()=>{clearTimeout(timer);reject(new Error('wrong-token socket failure'))})
 })
 assert.equal(rejected.ok,false)
 assert.match(rejected.error?.message??'',/token mismatch|unauthorized/i)
 console.log(`PASS tenant9 token rejected by tenant10 gateway: ${rejected.error.code}.`)
}finally{
 for(const page of pages){await page.evaluate(key=>localStorage.removeItem(key),markerKey).catch(()=>{});await page.close().catch(()=>{})}
 for(const browser of browsers)await browser.close().catch(()=>{})
 for(const tenant of tenants)await vm(tenant,'stop').catch(e=>console.error(e.message))
}
