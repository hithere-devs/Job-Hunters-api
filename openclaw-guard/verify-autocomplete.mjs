/** Root-only native Ashby-style autocomplete fixture. No real employer or user data. */
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
 let optionRef
 for(const [ref,metadata] of Object.entries(snapshot.refs??{}))if(metadata.role==='option'&&metadata.name==='Fixture City')optionRef=ref
 assert.ok(optionRef,'native snapshot must expose portaled option')
 let hook
 plugin.register({on:(name,handler)=>{if(name==='before_tool_call')hook=handler}})
 const invoke=()=>hook({toolName:'browser',params:{action:'act',profile:'tenant',targetId:policy.targetId,request:{kind:'click',ref:optionRef}}},{sessionKey:`agent:main:huntly-apply-${policy.attemptId}`})
 const permission=await invoke()
 assert.equal(permission.block,undefined,permission.blockReason)
 await pwAi.clickViaPlaywright({...opts,ref:optionRef})
 assert.equal(await page.getAttribute('body','data-selected'),'yes')
 assert.equal(await page.locator('#fixture-location').inputValue(),'Fixture City')
 const closed=await invoke()
 assert.equal(closed.block,true,'collapsed controller must invalidate option permission')
 console.log('PASS native portaled autocomplete: option bound to sole expanded nonsensitive field selected; collapsed controller denied.')
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
 await page.setContent(`<h1>Synthetic autocomplete fixture</h1><div class="ashby-application-form-field-entry"><label>Where are you currently located?</label><input id="fixture-location" class="ashby-application-form-input-autocomplete" role="combobox" aria-controls="popup1" aria-expanded="true" placeholder="Start typing..."></div><div role="listbox" id="popup1"><div role="option" class="ashby-application-form-input-autocomplete-popup-result" onclick="document.getElementById('fixture-location').value='Fixture City';document.getElementById('fixture-location').setAttribute('aria-expanded','false');document.body.dataset.selected='yes'">Fixture City</div></div>`)
 const cdp=await page.context().newCDPSession(page),{targetInfo}=await cdp.send('Target.getTargetInfo');await cdp.detach()
 await writeFile(policyPath,JSON.stringify({attemptId,targetId:targetInfo.targetId,allowedHosts:['example.com'],approvedFields:[],resumePath:null,deadlineEpoch:Date.now()+120000}),{mode:0o640});await chmod(policyPath,0o640);await chown(policyPath,0,gid)
 const child=spawnSync('/usr/bin/node',[new URL(import.meta.url).pathname,'--child'],{uid,gid,timeout:60000,encoding:'utf8',env:{...process.env,HOME:'/home/huntly-u9',OPENCLAW_STATE_DIR:state,HUNTLY_TENANT_INDEX:'9',HUNTLY_POLICY_PATH:policyPath,HUNTLY_OPENCLAW_ROOT:runtimeRoot}})
 process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0,'native guarded autocomplete must succeed')
}finally{
 await unlink(policyPath).catch(()=>{});await page?.close().catch(()=>{});await browser?.close().catch(()=>{});await vm('stop').catch(e=>console.error(e.message))
}
