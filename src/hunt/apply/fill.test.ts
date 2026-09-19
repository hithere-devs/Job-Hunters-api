import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { Page } from 'playwright-core'
import { formReady, pageLooksLikeNoForm, postingIsClosed, remeasureApplication, submitForm } from './fill.js'
import { withSubmissionGuard } from './submission-guard.js'

function fixturePage(confirmed:boolean) {
 let clicks=0; let observedBeforeClick=false
 const body={innerText:async()=>confirmed ? 'Thank you for applying' : 'Application form'}
 const submit={count:async()=>1,isVisible:async()=>true,evaluate:async()=>true,click:async()=>{clicks++}}
 const page={
  url:()=> 'https://fixture.invalid/apply',
  locator:(selector:string)=>selector==='body' ? body : {...submit,first:()=>submit},
  waitForFunction:async()=>{observedBeforeClick=clicks===0;if(!confirmed)throw new Error('fixture timeout')},
  waitForURL:async()=>{throw new Error('fixture same URL')},
  waitForSelector:async()=>{throw new Error('fixture form remains')},
  waitForResponse:async()=>{throw new Error('fixture no response')},
 } as unknown as Page
 return {page,clicks:()=>clicks,observedBeforeClick:()=>observedBeforeClick}
}
it('verification gate before click is invalid_fields and never clicks or fences',async()=>{
 let fences=0
 const submit={count:async()=>1,isVisible:async()=>true,evaluate:async()=>true,click:async()=>{throw new Error('must not click')}}
 const page={
  url:()=> 'https://job-boards.greenhouse.io/flexport/jobs/8141246',
  locator:(selector:string)=>selector==='body' ? {innerText:async()=>"A verification code was sent to mywritingfrenzy@gmail.com. Enter the 8-character code to confirm you're a human."} : {...submit,first:()=>submit},
  waitForFunction:async()=>{throw new Error('fixture timeout')},
  waitForURL:async()=>{throw new Error('fixture same URL')},
  waitForSelector:async()=>{throw new Error('fixture form remains')},
  waitForResponse:async()=>{throw new Error('fixture no response')},
 } as unknown as Page
 const result=await withSubmissionGuard(async()=>submitForm({page,url:'https://job-boards.greenhouse.io/flexport/jobs/8141246',dryRun:false}),async()=>{fences++})
 assert.equal(result.heldBack,'invalid_fields')
 assert.equal(result.result,'not_submitted')
 assert.equal(result.submitted,false)
 assert.equal(fences,0)
})
it('dry-run never clicks final submit',async()=>{
 const fixture=fixturePage(false)
 const result=await submitForm({page:fixture.page,url:'https://fixture.invalid/apply',dryRun:true})
 assert.equal(result.heldBack,'dry_run');assert.equal(fixture.clicks(),0)
})
it('absent confirmation after a fixture click is submitted_unconfirmed, never safe to retry',async()=>{
 const fixture=fixturePage(false)
 const result=await submitForm({page:fixture.page,url:'https://fixture.invalid/apply',dryRun:false})
 assert.equal(result.result,'submitted_unconfirmed');assert.equal(fixture.clicks(),1);assert.equal(fixture.observedBeforeClick(),true)
})
it('confirmation after a fixture click is submitted',async()=>{
 const fixture=fixturePage(true)
 const result=await submitForm({page:fixture.page,url:'https://fixture.invalid/apply',dryRun:false})
 assert.equal(result.result,'submitted');assert.equal(result.submitted,true)
})
it('validation banner after click is invalid_fields and never fences',async()=>{
 let bodyText='Application form'
 let fences=0
 const submit={count:async()=>1,isVisible:async()=>true,evaluate:async()=>true,click:async()=>{bodyText='Your form needs corrections. This field is required.'}}
 const page={
  url:()=> 'https://jobs.ashbyhq.com/fixture/application',
  locator:(selector:string)=>selector==='body' ? {innerText:async()=>bodyText} : {...submit,first:()=>submit},
  waitForFunction:async()=>{throw new Error('fixture timeout')},
  waitForURL:async()=>{throw new Error('fixture same URL')},
  waitForSelector:async()=>{throw new Error('fixture form remains')},
  waitForResponse:async()=>{throw new Error('fixture no response')},
 } as unknown as Page
 const result=await withSubmissionGuard(async()=>submitForm({page,url:'https://jobs.ashbyhq.com/fixture/application',dryRun:false}),async()=>{fences++})
 assert.equal(result.heldBack,'invalid_fields');assert.equal(result.result,'not_submitted');assert.equal(fences,0)
})
it('durable provider POST still fences as submitted_unconfirmed',async()=>{
 let fences=0
 const submit={count:async()=>1,isVisible:async()=>true,evaluate:async()=>true,click:async()=>{}}
 const page={
  url:()=> 'https://jobs.ashbyhq.com/fixture/application',
  locator:(selector:string)=>selector==='body' ? {innerText:async()=>'Application form'} : {...submit,first:()=>submit},
  waitForFunction:async()=>{throw new Error('fixture timeout')},
  waitForURL:async()=>{throw new Error('fixture same URL')},
  waitForSelector:async()=>{throw new Error('fixture form remains')},
  waitForResponse:async()=>'ok',
 } as unknown as Page
 const result=await withSubmissionGuard(async()=>submitForm({page,url:'https://jobs.ashbyhq.com/fixture/application',dryRun:false}),async()=>{fences++})
 assert.equal(result.result,'submitted_unconfirmed');assert.equal(fences,1)
})
it('durable POST plus validation banner is invalid_fields and never fences',async()=>{
 let bodyText='Application form'
 let fences=0
 const submit={count:async()=>1,isVisible:async()=>true,evaluate:async()=>true,click:async()=>{bodyText='Your form needs corrections\nMissing entry for required field: How did you learn about this opportunity with Atlan?'}}
 const page={
  url:()=> 'https://jobs.ashbyhq.com/fixture/application',
  locator:(selector:string)=>selector==='body' ? {innerText:async()=>bodyText} : {...submit,first:()=>submit},
  waitForFunction:async()=>{throw new Error('fixture timeout')},
  waitForURL:async()=>{throw new Error('fixture same URL')},
  waitForSelector:async()=>{throw new Error('fixture form remains')},
  waitForResponse:async()=>'ok',
 } as unknown as Page
 const result=await withSubmissionGuard(async()=>submitForm({page,url:'https://jobs.ashbyhq.com/fixture/application',dryRun:false}),async()=>{fences++})
 assert.equal(result.heldBack,'invalid_fields');assert.equal(result.result,'not_submitted');assert.equal(fences,0)
})
it('delayed Greenhouse processing error after a 2xx POST is invalid_fields and never fences',async()=>{
 let reads=0
 let fences=0
 const submit={count:async()=>1,isVisible:async()=>true,evaluate:async()=>true,click:async()=>{}}
 const page={
  url:()=> 'https://job-boards.greenhouse.io/reddit/jobs/8175520',
  locator:(selector:string)=>selector==='body' ? {innerText:async()=>{
    reads+=1
    return reads<3 ? 'Application form Submit application' : 'There was an error processing your application. Please try again.\nSubmit application'
  }} : {...submit,first:()=>submit},
  waitForFunction:async()=>{throw new Error('fixture timeout')},
  waitForURL:async()=>{throw new Error('fixture same URL')},
  waitForSelector:async()=>{throw new Error('fixture form remains')},
  waitForResponse:async()=>'ok',
 } as unknown as Page
 const result=await withSubmissionGuard(async()=>submitForm({page,url:'https://job-boards.greenhouse.io/reddit/jobs/8175520',dryRun:false}),async()=>{fences++})
 assert.equal(result.heldBack,'invalid_fields')
 assert.equal(result.result,'not_submitted')
 assert.equal(fences,0)
 assert.ok(reads>=3)
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
