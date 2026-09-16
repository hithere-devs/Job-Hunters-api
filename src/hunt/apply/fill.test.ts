import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { Page } from 'playwright-core'
import { submitForm } from './fill.js'

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
