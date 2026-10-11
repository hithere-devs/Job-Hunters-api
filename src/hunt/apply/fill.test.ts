import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { Page } from 'playwright-core'
import { formReady, pageLooksLikeNoForm, postingIsClosed, remeasureApplication, submitForm } from './fill.js'
import { withSubmissionGuard } from './submission-guard.js'

const FAST={visibleMs:300,writesMs:200,quietMs:10,pollMs:20}

/**
 * A fake page rich enough for the click evidence: in-page state, submit
 * visibility, and the request events the network watch listens to.
 */
function clickFixture(options:{url?:string;text?:string;onClick?:(page:{state:Record<string,unknown>;send:(method:string,path:string,status:number)=>void})=>void}={}) {
 const url=options.url ?? 'https://jobs.ashbyhq.com/fixture/application'
 const state:Record<string,unknown>={url,text:options.text ?? 'Application form\nSubmit application',formPresent:true,submitVisible:true,invalidCount:0,errorTexts:[],codeInputs:0}
 const listeners:Record<string,Array<(arg:unknown)=>void>>={}
 let clicks=0
 const send=(method:string,path:string,status:number)=>{
  const response={status:()=>status}
  const request={method:()=>method,url:()=>new URL(path,url).toString(),isNavigationRequest:()=>false,response:async()=>response}
  for(const fn of listeners.request??[])fn(request)
  for(const fn of listeners.requestfinished??[])fn(request)
 }
 const submit={count:async()=>1,isVisible:async()=>Boolean(state.submitVisible),evaluate:async()=>true,click:async()=>{clicks++;options.onClick?.({state,send})}}
 const page={
  url:()=>String(state.url),
  locator:(selector:string)=>selector==='body'?{innerText:async()=>String(state.text)}:{...submit,first:()=>submit},
  evaluate:async(_fn:unknown,arg?:unknown)=>typeof arg==='string'?{emptyCombobox:false,emptyYesNo:false,emptySelect:false,emptyResume:false,emptyText:false}:({url:state.url,text:state.text,formPresent:state.formPresent,invalidCount:state.invalidCount,errorTexts:state.errorTexts,codeInputs:state.codeInputs}),
  on:(event:string,fn:(arg:unknown)=>void)=>{(listeners[event]??=[]).push(fn)},
  off:(event:string,fn:(arg:unknown)=>void)=>{listeners[event]=(listeners[event]??[]).filter(item=>item!==fn)},
 } as unknown as Page
 return {page,clicks:()=>clicks,state}
}
async function withOpenPosting<T>(work:()=>Promise<T>):Promise<T>{
 const original=globalThis.fetch
 globalThis.fetch=(async()=>new Response('{}',{status:200})) as typeof fetch
 try { return await work() } finally { globalThis.fetch=original }
}
function guarded<T>(work:()=>Promise<T>){
 const record={fences:0,outcomes:[] as string[]}
 return withSubmissionGuard(work,async()=>{record.fences++},async(outcome)=>{record.outcomes.push(outcome)}).then(result=>({result,...record}))
}
it('verification gate before click is invalid_fields and never clicks or fences',async()=>{
 let fences=0
 const submit={count:async()=>1,isVisible:async()=>true,evaluate:async()=>true,click:async()=>{throw new Error('must not click')}}
 const page={
  url:()=> 'https://job-boards.greenhouse.io/flexport/jobs/8141246',
  locator:(selector:string)=>selector==='body' ? {innerText:async()=>"A verification code was sent to mywritingfrenzy@gmail.com. Enter the 8-character code to confirm you're a human."} : {...submit,first:()=>submit},
 } as unknown as Page
 const result=await withSubmissionGuard(async()=>submitForm({page,url:'https://job-boards.greenhouse.io/flexport/jobs/8141246',dryRun:false}),async()=>{fences++})
 assert.equal(result.heldBack,'invalid_fields')
 assert.equal(result.result,'not_submitted')
 assert.equal(result.submitted,false)
 assert.equal(fences,0)
})
it('dry-run never clicks final submit',async()=>{
 const fixture=clickFixture()
 const result=await submitForm({page:fixture.page,url:'https://fixture.invalid/apply',dryRun:true,settle:FAST})
 assert.equal(result.heldBack,'dry_run');assert.equal(fixture.clicks(),0)
})
it('the fence is written before the click, and an accepted write with no confirmation is uncertain',async()=>{
 const order:string[]=[]
 const fixture=clickFixture({onClick:({send})=>{order.push('click');send('POST','/api/non-user-graphql',200)}})
 const {result,outcomes}=await withSubmissionGuard(async()=>({result:await submitForm({page:fixture.page,url:'https://jobs.ashbyhq.com/fixture/application',dryRun:false,settle:FAST}),outcomes:[]}),async()=>{order.push('fence')})
 assert.deepEqual(order,['fence','click'])
 assert.equal(result.result,'submitted_unconfirmed');assert.equal(result.outcome,'uncertain');assert.equal(outcomes.length,0)
})
it('confirmation text after the form closes is submitted',async()=>{
 const fixture=clickFixture({onClick:({state,send})=>{send('POST','/api/non-user-graphql',200);state.text='Thanks for applying!\nYour application was successfully submitted.';state.formPresent=false;state.submitVisible=false}})
 const {result,fences,outcomes}=await guarded(()=>submitForm({page:fixture.page,url:'https://jobs.ashbyhq.com/fixture/application',dryRun:false,settle:FAST}))
 assert.equal(result.result,'submitted');assert.equal(result.submitted,true);assert.equal(fences,1);assert.deepEqual(outcomes,['confirmed'])
})
it('a job description that says thank you never confirms a click that sent nothing',async()=>{
 const fixture=clickFixture({url:'https://job-boards.greenhouse.io/acme/jobs/1',text:'About Acme\nThank you for your interest in Acme!\nSubmit application'})
 const {result,outcomes}=await withOpenPosting(()=>guarded(()=>submitForm({page:fixture.page,url:'https://job-boards.greenhouse.io/acme/jobs/1',dryRun:false,settle:FAST})))
 assert.equal(result.submitted,false);assert.equal(result.heldBack,'invalid_fields');assert.deepEqual(outcomes,['rejected_validation'])
})
it('validation banner after click is a provable rejection and allows a corrected re-click',async()=>{
 let round=0
 const fixture=clickFixture({onClick:({state,send})=>{
  round++
  if(round===1){state.text='Application form\nYour form needs corrections. This field is required.';state.errorTexts=['This field is required.'];state.invalidCount=1;return}
  send('POST','/api/non-user-graphql',200);state.text='Your application was successfully submitted.';state.formPresent=false;state.submitVisible=false
 }})
 const {result,fences,outcomes}=await guarded(async()=>{
  const first=await submitForm({page:fixture.page,url:'https://jobs.ashbyhq.com/fixture/application',dryRun:false,settle:FAST})
  assert.equal(first.heldBack,'invalid_fields');assert.equal(first.result,'not_submitted');assert.equal(first.outcome,'rejected_validation')
  // The executor repairs the field; the banner goes away.
  fixture.state.text='Application form\nSubmit application';fixture.state.errorTexts=[];fixture.state.invalidCount=0
  return submitForm({page:fixture.page,url:'https://jobs.ashbyhq.com/fixture/application',dryRun:false,settle:FAST})
 })
 assert.equal(result.submitted,true);assert.equal(fences,2);assert.deepEqual(outcomes,['rejected_validation','confirmed'])
})
it('durable POST plus validation banner is a rejection, not a submission',async()=>{
 const fixture=clickFixture({onClick:({state,send})=>{send('POST','/api/non-user-graphql',422);state.text='Your form needs corrections\nMissing entry for required field: How did you learn about this opportunity with Atlan?'}})
 const {result,outcomes}=await guarded(()=>submitForm({page:fixture.page,url:'https://jobs.ashbyhq.com/fixture/application',dryRun:false,settle:FAST}))
 assert.equal(result.heldBack,'invalid_fields');assert.equal(result.result,'not_submitted');assert.deepEqual(outcomes,['rejected_validation'])
})
it('Greenhouse processing error after a 2xx POST is a rejection',async()=>{
 const fixture=clickFixture({url:'https://job-boards.greenhouse.io/reddit/jobs/8175520',onClick:({state,send})=>{send('POST','/reddit/jobs/8175520/applications',200);state.text='Application form\nThere was an error processing your application. Please try again.\nSubmit application'}})
 const {result,outcomes}=await withOpenPosting(()=>guarded(()=>submitForm({page:fixture.page,url:'https://job-boards.greenhouse.io/reddit/jobs/8175520',dryRun:false,settle:FAST})))
 assert.equal(result.heldBack,'invalid_fields');assert.equal(result.result,'not_submitted');assert.deepEqual(outcomes,['rejected_validation'])
})
it('the emailed-code gate after a click is verification_required and permits a second click',async()=>{
 const fixture=clickFixture({url:'https://job-boards.greenhouse.io/acme/jobs/1',onClick:({state,send})=>{send('POST','/acme/jobs/1/applications',200);state.text='Application form\nA verification code was sent to you. Enter the 8-character code.';state.codeInputs=8}})
 const {result,outcomes}=await withOpenPosting(()=>guarded(()=>submitForm({page:fixture.page,url:'https://job-boards.greenhouse.io/acme/jobs/1',dryRun:false,settle:FAST})))
 assert.equal(result.result,'verification_required');assert.deepEqual(outcomes,['verification_required'])
})
it('empty required combobox is not formReady',async()=>{
 const submit={count:async()=>1,isVisible:async()=>true,evaluate:async()=>true,click:async()=>{throw new Error('must not click')}}
 const page={
  url:()=> 'https://jobs.ashbyhq.com/fixture/application',
  locator:(selector:string)=>selector==='body' ? {innerText:async()=>'Application form'} : {...submit,first:()=>submit},
  evaluate:async()=>({emptyCombobox:true,emptyYesNo:false,emptySelect:false,emptyResume:false}),
 } as unknown as Page
 const ready=await formReady(page,'https://jobs.ashbyhq.com/fixture/application')
 assert.equal(ready.ok,false)
 const result=await submitForm({page,url:'https://jobs.ashbyhq.com/fixture/application',dryRun:false})
 assert.equal(result.heldBack,'invalid_fields')
})
function listingFixture(bodyText:string, url='https://job-boards.greenhouse.io/gitlab') {
 const empty={count:async()=>0,isVisible:async()=>false,first(){return this},evaluate:async()=>false}
 return {
  url:()=>url,
  locator:(selector:string)=>selector==='body'?{innerText:async()=>bodyText}:empty,
  evaluate:async()=>({emptyCombobox:false,emptyYesNo:false,emptySelect:false,emptyResume:false}),
 } as unknown as Page
}
it('gitlab board listing is no_form, never automation_limit',async()=>{
 const page=listingFixture('Current openings at GitLab\n221 jobs')
 assert.equal(await pageLooksLikeNoForm(page),true)
 const measured=await remeasureApplication(page,'https://job-boards.greenhouse.io/gitlab')
 assert.equal(measured.canSubmit,false)
 assert.equal(measured.unresolved[0]?.why,'no_form')
 assert.equal(measured.unresolved.some(field=>field.why==='automation_limit'),false)
 const result=await submitForm({page,url:'https://job-boards.greenhouse.io/gitlab',dryRun:false})
 assert.equal(result.heldBack,'no_form')
})
it('chrome redirect loop is no_form',async()=>{
 const page=listingFixture("This page isn't working\njobs.elastic.co redirected you too many times.\nERR_TOO_MANY_REDIRECTS",'chrome-error://chromewebdata/')
 assert.equal(await pageLooksLikeNoForm(page),true)
 const measured=await remeasureApplication(page,'https://jobs.elastic.co/jobs/8154997')
 assert.equal(measured.unresolved[0]?.why,'no_form')
})
it('custom-domain gh_jid listing is no_form until the Greenhouse form URL is opened',async()=>{
 const page=listingFixture('Elastic careers\nAI QA Engineer', 'https://jobs.elastic.co/jobs?gh_jid=8154997&gh_jid=8154997')
 assert.equal(await pageLooksLikeNoForm(page),true)
})
it('a Greenhouse job URL is not no_form just because the Apply form has not opened yet',async()=>{
 const page=listingFixture('', 'https://job-boards.greenhouse.io/gitlab/jobs/8775507002')
 assert.equal(await pageLooksLikeNoForm(page),false)
})
it('Greenhouse error=true is a closed posting',async()=>{
 const page=listingFixture('Jobs at GitLab', 'https://job-boards.greenhouse.io/gitlab?error=true')
 assert.equal(await postingIsClosed(page),true)
 assert.equal(await pageLooksLikeNoForm(page),true)
 const embed=listingFixture('Jobs at GitLab', 'https://job-boards.greenhouse.io/embed/job_board?for=gitlab&error=true')
 assert.equal(await postingIsClosed(embed),true)
})
it('Greenhouse job API 404 is a closed posting',async()=>{
 const original=globalThis.fetch
 globalThis.fetch=(async()=>new Response('{"error":"Job not found"}',{status:404})) as typeof fetch
 try {
  const page=listingFixture('', 'https://job-boards.greenhouse.io/gitlab/jobs/8775507002')
  assert.equal(await postingIsClosed(page),true)
 } finally {
  globalThis.fetch=original
 }
})
it('Greenhouse API 404 on the requested URL is closed even when the live page is a board listing',async()=>{
 const original=globalThis.fetch
 globalThis.fetch=(async(input: Parameters<typeof fetch>[0])=> {
  const href=String(input)
  if (href.includes('/jobs/8775507002')) return new Response('{"error":"Job not found"}',{status:404})
  return new Response('{}',{status:200})
 }) as typeof fetch
 try {
  const page=listingFixture('Current openings at GitLab\n221 jobs', 'https://job-boards.greenhouse.io/gitlab')
  assert.equal(await postingIsClosed(page, ['https://job-boards.greenhouse.io/embed/job_app?for=gitlab&token=8775507002']), true)
 } finally {
  globalThis.fetch=original
 }
})
it('OpenClaw canSubmit false with empty unresolved is needs_input, not automation_limit',async()=>{
 const submit={count:async()=>1,isVisible:async()=>true,evaluate:async()=>true,click:async()=>{throw new Error('must not click')},first(){return this}}
 const page={
  url:()=>'https://jobs.ashbyhq.com/fixture/application',
  locator:(selector:string)=>selector==='body'?{innerText:async()=>'Application'}:submit,
  evaluate:async(_fn:unknown,arg?:unknown)=>typeof arg==='string'?{emptyCombobox:false,emptyYesNo:false,emptySelect:true,emptyResume:true,emptyText:false}:[],
 } as unknown as Page
 const measured=await remeasureApplication(page,'https://jobs.ashbyhq.com/fixture/application')
 assert.equal(measured.canSubmit,false)
 assert.equal(measured.unresolved[0]?.why,'needs_input')
 assert.equal(measured.unresolved.some(field=>field.why==='automation_limit'),false)
})
