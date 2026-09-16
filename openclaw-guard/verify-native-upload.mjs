/** Root-only native upload fixture. No user resume, credentials or real employer form. */
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
 let inputRef
 for(const ref of Object.keys(snapshot.refs??{})){
  const locator=pwAi.refLocator(page,ref)
  if(await locator.evaluate(el=>el.tagName==='INPUT'&&el.getAttribute('type')==='file').catch(()=>false)){inputRef=ref;break}
 }
 assert.ok(inputRef,'native snapshot must bind the fixture file-input ref')
 await page.locator('#resume').evaluate(el=>{el.style.display='none'})
 let hook
 plugin.register({on:(name,handler)=>{if(name==='before_tool_call')hook=handler}})
 const permission=await hook({toolName:'browser',params:{action:'upload',profile:'tenant',targetId:policy.targetId,inputRef,paths:[policy.resumePath]}},{sessionKey:`agent:main:huntly-apply-${policy.attemptId}`})
 assert.equal(permission.block,undefined,permission.blockReason)
 await pwAi.setInputFilesViaPlaywright({...opts,inputRef,paths:permission.params.paths})
 const uploaded=await page.locator('#resume').evaluate(el=>({count:el.files.length,name:el.files[0]?.name,size:el.files[0]?.size}))
 assert.equal(uploaded.count,1);assert.equal(uploaded.name,`${policy.attemptId}-resume.pdf`);assert.ok(uploaded.size>0)
 console.log('PASS native OpenClaw upload: guarded hidden file input received synthetic PDF from tenant managed inbound-media path.')
 await pwAi.closePlaywrightBrowserConnection({cdpUrl:opts.cdpUrl})
 process.exit(0)
}
if(process.getuid()!==0)throw new Error('Run on VM as root')
const {chromium}=await import('/opt/huntly/api/node_modules/playwright-core/index.mjs')
const token=(await readFile('/etc/huntly/vm-agent.env','utf8')).split('\n').find(l=>l.startsWith('VM_AGENT_TOKEN=')).slice(15).replace(/^"|"$/g,'')
const vm=async action=>{const r=await fetch(`http://127.0.0.1:18900/tenants/9/${action}`,{method:'POST',headers:{Authorization:`Bearer ${token}`}});if(!r.ok)throw new Error(`fixture VM ${action} HTTP ${r.status}`);return r.json()}
const uid=Number(execFileSync('id',['-u','huntly-u9'],{encoding:'utf8'}).trim()),gid=Number(execFileSync('id',['-g','huntly-u9'],{encoding:'utf8'}).trim())
const attemptId=randomUUID(),state='/home/huntly-u9/.openclaw-huntly-u9',file=`${state}/media/inbound/${attemptId}-resume.pdf`,policyPath='/run/huntly-openclaw/tenant-9.json'
let browser,page
try{
 const info=await vm('apply');browser=await chromium.connectOverCDP(info.cdpUrl);page=await browser.contexts()[0].newPage()
 await page.goto('https://example.com',{waitUntil:'domcontentloaded',timeout:30000})
 await page.setContent('<h1>Synthetic upload fixture</h1><label for="resume">Resume</label><input id="resume" type="file">')
 const cdp=await page.context().newCDPSession(page),{targetInfo}=await cdp.send('Target.getTargetInfo');await cdp.detach()
 await mkdir(`${state}/media/inbound`,{recursive:true,mode:0o700});await chown(`${state}/media`,uid,gid);await chown(`${state}/media/inbound`,uid,gid)
 await writeFile(file,'%PDF-1.4\n% synthetic upload fixture, no personal information\n%%EOF\n',{mode:0o600});await chown(file,uid,gid)
 await writeFile(policyPath,JSON.stringify({attemptId,targetId:targetInfo.targetId,allowedHosts:['example.com'],approvedFields:[],resumePath:file,deadlineEpoch:Date.now()+120000}),{mode:0o640});await chmod(policyPath,0o640);await chown(policyPath,0,gid)
 const child=spawnSync('/usr/bin/node',[new URL(import.meta.url).pathname,'--child'],{uid,gid,timeout:60000,encoding:'utf8',env:{...process.env,HOME:'/home/huntly-u9',OPENCLAW_STATE_DIR:state,HUNTLY_TENANT_INDEX:'9',HUNTLY_POLICY_PATH:policyPath,HUNTLY_OPENCLAW_ROOT:runtimeRoot}})
 process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0,'native guarded upload must succeed')
}finally{
 await unlink(policyPath).catch(()=>{});await unlink(file).catch(()=>{});await page?.close().catch(()=>{});await browser?.close().catch(()=>{});await vm('stop').catch(e=>console.error(e.message))
}
