/** Root-only native Ashby-style boolean fixture. No real employer or user data. */
import assert from 'node:assert/strict'
import { readFile, writeFile, chmod, chown, mkdir, unlink } from 'node:fs/promises'
import { spawnSync, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
const runtimeRoot='/opt/huntly/openclaw-runtime/node_modules/openclaw'
if(process.argv.includes('--child')) {
 const {default:plugin}=await import('./index.mjs')
 const {pwAi}=await import(`${runtimeRoot}/dist/pw-ai-CCc7uQCy.mjs`)
 const policy=JSON.parse(await readFile(process.env.HUNTLY_POLICY_PATH,'utf8'))
 const opts={cdpUrl:'http://127.0.0.1:9209',targetId:policy.targetId}
 const page=await pwAi.getPageForTargetId(opts)
 const snapshot=await pwAi.snapshotAiViaPlaywright(opts)
 const refs={}
 for(const ref of Object.keys(snapshot.refs??{})){
  const name=await pwAi.refLocator(page,ref).evaluate(el=>el.tagName==='BUTTON'?el.textContent.trim():null).catch(()=>null)
  if(name)refs[name]=ref
 }
 assert.ok(refs.Yes&&refs.No&&refs['Submit application'])
 let hook
 plugin.register({on:(name,handler)=>{if(name==='before_tool_call')hook=handler}})
 const invoke=ref=>hook({toolName:'browser',params:{action:'act',profile:'tenant',targetId:policy.targetId,request:{kind:'click',ref}}},{sessionKey:`agent:main:huntly-apply-${policy.attemptId}`})
 const yes=await invoke(refs.Yes)
 assert.equal(yes.block,true,'unapproved true must remain denied')
 const no=await invoke(refs.No)
 assert.equal(no.block,undefined,no.blockReason)
 await pwAi.clickViaPlaywright({...opts,ref:refs.No})
 assert.equal(await page.getAttribute('body','data-choice'),'No')
 const submit=await invoke(refs['Submit application'])
 assert.equal(submit.block,true,'real final submit control remains denied')
 assert.notEqual(await page.getAttribute('body','data-submitted'),'yes')
 console.log('PASS native Ashby boolean guard: exact approved false clicked No; unapproved Yes and final submit denied; no submit event fired.')
 await pwAi.closePlaywrightBrowserConnection({cdpUrl:opts.cdpUrl})
 process.exit(0)
}
if(process.getuid()!==0)throw new Error('Run on VM as root')
const {chromium}=await import('/opt/huntly/api/node_modules/playwright-core/index.mjs')
const token=(await readFile('/etc/huntly/vm-agent.env','utf8')).split('\n').find(l=>l.startsWith('VM_AGENT_TOKEN=')).slice(15).replace(/^"|"$/g,'')
const vm=async action=>{const r=await fetch(`http://127.0.0.1:18900/tenants/9/${action}`,{method:'POST',headers:{Authorization:`Bearer ${token}`}});if(!r.ok)throw new Error(`fixture VM ${action} HTTP ${r.status}`);return r.json()}
const uid=Number(execFileSync('id',['-u','huntly-u9'],{encoding:'utf8'}).trim()),gid=Number(execFileSync('id',['-g','huntly-u9'],{encoding:'utf8'}).trim())
const attemptId=randomUUID(),state='/home/huntly-u9/.openclaw-huntly-u9',policyPath='/run/huntly-openclaw/tenant-9.json'
let browser,page
try{
 const info=await vm('apply');browser=await chromium.connectOverCDP(info.cdpUrl);page=await browser.contexts()[0].newPage()
 await page.goto('https://example.com',{waitUntil:'domcontentloaded',timeout:30000})
 await page.setContent(`<h1>Synthetic Ashby fixture</h1><form onsubmit="event.preventDefault();document.body.dataset.submitted='yes'"><div class="ashby-application-form-field-entry"><label>Are you legally authorized to work in the United States?</label><div class="ashby-application-form-input-yesno"><button onclick="event.preventDefault();document.body.dataset.choice='Yes'">Yes</button><button onclick="event.preventDefault();document.body.dataset.choice='No'">No</button></div></div><button type="submit">Submit application</button></form>`)
 const cdp=await page.context().newCDPSession(page),{targetInfo}=await cdp.send('Target.getTargetInfo');await cdp.detach()
 await writeFile(policyPath,JSON.stringify({attemptId,targetId:targetInfo.targetId,allowedHosts:['example.com'],approvedFields:[{label:'Are you legally authorized to work in the United States?',type:'checkbox',value:'false'}],resumePath:null,deadlineEpoch:Date.now()+120000}),{mode:0o640});await chmod(policyPath,0o640);await chown(policyPath,0,gid)
 const child=spawnSync('/usr/bin/node',[new URL(import.meta.url).pathname,'--child'],{uid,gid,timeout:60000,encoding:'utf8',env:{...process.env,HOME:'/home/huntly-u9',OPENCLAW_STATE_DIR:state,HUNTLY_TENANT_INDEX:'9',HUNTLY_POLICY_PATH:policyPath,HUNTLY_OPENCLAW_ROOT:runtimeRoot}})
 process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0,'native guarded boolean must succeed')
}finally{
 await unlink(policyPath).catch(()=>{});await page?.close().catch(()=>{});await browser?.close().catch(()=>{});await vm('stop').catch(e=>console.error(e.message))
}
