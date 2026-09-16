import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decide, validatePolicy, assertRunContext } from './guard.mjs'
const now = 1000000
const policy = () => ({ attemptId: 'attempt', targetId: 'TARGET1', allowedHosts: ['jobs.ashbyhq.com'], approvedFields: [], resumePath: '/tmp/openclaw/uploads/resume.pdf', deadlineEpoch: now + 300000 })
const facts = () => ({ targetId: 'TARGET1', url: 'https://jobs.ashbyhq.com/company/id/application', frameUrls: ['https://jobs.ashbyhq.com/company/id/application'], hasAuthentication: false, wizardStep: null })
const node = () => ({ tag: 'input', type: 'text', label: 'First name', name: '', role: '', visible: true, disabled: false, checked: false })
const event = request => ({ toolName: 'browser', params: { action: 'act', request } })
const check = (e, p = policy(), f = facts(), n = node()) => decide(e, p, f, async () => n, now)
test('missing/expired policy fails closed', async () => {
 assert.throws(() => validatePolicy({...policy(),deadlineEpoch:now},now))
 assert.equal((await check(event({kind:'type',ref:'e1',text:'Ada'}),null)).block,true)
})
test('denies exec, read, evaluate, arbitrary keys, batches, coordinates, storage and navigation', async () => {
 for(const toolName of ['exec','read','write','web_fetch','sessions_spawn']) assert.equal((await check({toolName,params:{}})).block,true)
 for(const kind of ['evaluate','press','batch','clickCoords','drag','close']) assert.equal((await check(event({kind,ref:'e1'}))).block,true)
 for(const action of ['navigate','open','tabs','dialog','requests','console','cookies','storage','text']) assert.equal((await check({toolName:'browser',params:{action}})).block,true)
})
test('pins profile and target and rejects routes to another tenant', async () => {
 const safe=await check(event({kind:'type',ref:'e1',text:'Ada'}))
 assert.equal(safe.params.profile,'tenant');assert.equal(safe.params.targetId,'TARGET1')
 for(const override of [{targetId:'TARGET2'},{profile:'other'},{target:'node'},{node:'other'}]) assert.equal((await check({toolName:'browser',params:{action:'snapshot',...override}})).block,true)
})
test('inspection denies authentication and off-host pages before returning content', async () => {
 const e={toolName:'browser',params:{action:'snapshot'}}
 assert.equal((await check(e,policy(),{...facts(),hasAuthentication:true})).block,true)
 assert.equal((await check(e,policy(),{...facts(),url:'https://jobs.ashbyhq.com.evil.test'})).block,true)
 assert.equal((await check(e,policy(),{...facts(),frameUrls:['https://accounts.google.com']})).block,true)
 assert.equal((await check(e)).params.refs,'aria')
})
test('ordinary text fills remain allowed but credential fields never do', async () => {
 assert.equal((await check(event({kind:'type',ref:'e1',text:'Ada'}))).block,undefined)
 for(const label of ['Password','One-time verification code','API key']) {
  const p=policy();p.approvedFields=[{label,type:'text',value:'secret'}]
  assert.equal((await check(event({kind:'type',ref:'e1',text:'secret'}),p,facts(),{...node(),label})).block,true)
 }
 assert.equal((await check(event({kind:'type',ref:'e1',text:'Ada',submit:true}))).block,true)
})
test('sensitive field requires exact host-observed label/type/value approval', async () => {
 const n={...node(),label:'Will you require sponsorship in the United States?'}
 const p=policy();p.approvedFields=[{label:n.label,type:n.type,value:'Yes'}]
 assert.equal((await check(event({kind:'type',ref:'e1',text:'Yes'}),p,facts(),n)).block,undefined)
 assert.equal((await check(event({kind:'type',ref:'e1',text:'No'}),p,facts(),n)).block,true)
 assert.equal((await check(event({kind:'type',ref:'e1',text:'Yes'}),policy(),facts(),n)).block,true)
})
test('final submit denied, Next requires positive intermediate wizard proof', async () => {
 const button={...node(),tag:'button',type:'submit',name:'Submit application',label:'Submit application'}
 assert.equal((await check(event({kind:'click',ref:'e1'}),policy(),facts(),button)).block,true)
 const next={...button,name:'Next',label:'Next'}
 assert.equal((await check(event({kind:'click',ref:'e1'}),policy(),facts(),next)).block,true)
 assert.equal((await check(event({kind:'click',ref:'e1'}),policy(),{...facts(),wizardStep:{current:1,total:3}},next)).block,undefined)
 assert.equal((await check(event({kind:'click',ref:'e1'}),policy(),{...facts(),wizardStep:{current:3,total:3}},next)).block,true)
})
test('upload requires exact approved resume path and a file input ref', async () => {
 const e={toolName:'browser',params:{action:'upload',paths:[policy().resumePath],inputRef:'e1'}}
 const file={...node(),type:'file',label:'Resume'}
 assert.equal((await check(e,policy(),facts(),file)).block,undefined)
 assert.equal((await check({...e,params:{...e.params,paths:['/etc/passwd']}},policy(),facts(),file)).block,true)
 assert.equal((await check(e)).block,true)
})

test('flat act syntax is rewritten to the same constrained nested request', async () => {
 const result=await check({toolName:'browser',params:{action:'act',kind:'type',ref:'e1',text:'Ada'}})
 assert.equal(result.params.request.text,'Ada')
 assert.equal(result.params.request.submit,false)
})
test('fill batch cannot hide one unapproved sensitive or credential field', async () => {
 const result=await decide(event({kind:'fill',fields:[{ref:'e1',value:'Ada'},{ref:'e2',value:'Yes'}]}),policy(),facts(),async(ref)=>ref==='e1'?node():{...node(),label:'US sponsorship'},now)
 assert.equal(result.block,true)
})

test('a Yes/No choice without host-observed question context cannot evade sensitive policy', async () => {
 const option={...node(),tag:'div',type:'radio',role:'radio',name:'Yes',label:'Yes',choiceContext:false}
 assert.equal((await check(event({kind:'click',ref:'e1'}),policy(),facts(),option)).block,true)
})

test('policy session belongs to the exact attempt, never another run or missing context', () => {
 assert.doesNotThrow(()=>assertRunContext(policy(),{sessionKey:'agent:main:huntly-apply-attempt'}))
 for(const context of [{},{sessionKey:'agent:main:huntly-apply-other'},undefined]) assert.throws(()=>assertRunContext(policy(),context),/policy_session_mismatch/)
})
