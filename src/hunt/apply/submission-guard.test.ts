import assert from 'node:assert/strict'
import { it } from 'node:test'
import { beforeSubmission, submissionWasAttempted, withSubmissionGuard } from './submission-guard.js'

it('a failed durable intent prevents the browser callback from running',async()=>{
 let clicked=false
 await assert.rejects(withSubmissionGuard(async()=>{await beforeSubmission();clicked=true},async()=>{throw new Error('database unavailable')}),/database unavailable/)
 assert.equal(clicked,false)
})
it('records irreversible intent before click and refuses a second submit',async()=>{
 const calls:string[]=[]
 await withSubmissionGuard(async()=>{
  await beforeSubmission();calls.push('click')
  assert.equal(submissionWasAttempted(),true)
  await assert.rejects(beforeSubmission(),/already attempted/)
 },async()=>{calls.push('durable intent')})
 assert.deepEqual(calls,['durable intent','click'])
})
it('submission scopes do not leak across concurrent users',async()=>{
 let fences=0
 await Promise.all([1,2].map(()=>withSubmissionGuard(async()=>{await beforeSubmission()},async()=>{fences++})))
 assert.equal(fences,2)
 assert.equal(submissionWasAttempted(),false)
})
it('allows another click only after a provably rejected one',async()=>{
 const { recordSubmissionOutcome, releaseSubmissionAfterRejection } = await import('./submission-guard.js')
 const outcomes:string[]=[]
 let fences=0
 await withSubmissionGuard(async()=>{
  await beforeSubmission()
  await recordSubmissionOutcome('rejected_validation','errors shown')
  releaseSubmissionAfterRejection()
  assert.equal(submissionWasAttempted(),false)
  await beforeSubmission()
  await recordSubmissionOutcome('uncertain','no signal')
  assert.throws(()=>releaseSubmissionAfterRejection(),/provably rejected/)
  await assert.rejects(beforeSubmission(),/already attempted/)
 },async()=>{fences++},async(outcome)=>{outcomes.push(outcome)})
 assert.equal(fences,2)
 assert.deepEqual(outcomes,['rejected_validation','uncertain'])
})
