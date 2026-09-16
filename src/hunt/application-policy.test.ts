import assert from 'node:assert/strict'
import { describe,it } from 'node:test'
import { dailyBudget,effectiveConcurrency,safeRetryReason } from './application-policy.js'

describe('application execution policy',()=>{
  it('subtracts previous batches and resets at UTC midnight',()=>{
    const budget=dailyBudget(98,100,new Date('2026-09-16T23:59:59Z'))
    assert.equal(budget.remaining,2)
    assert.equal(budget.resetsAt,'2026-09-17T00:00:00.000Z')
    assert.equal(dailyBudget(105).remaining,0)
  })
  it('serializes one VM profile even with multiple configured slots',()=>{
    assert.equal(effectiveConcurrency(4,true),1)
    assert.equal(effectiveConcurrency(2,false),2)
    assert.equal(effectiveConcurrency(99,false),4)
    assert.equal(effectiveConcurrency(0,false),1)
  })
  it('never retries unknown or confirmed submissions',()=>{
    for(const status of ['unknown','submitting','submitted','submitted_unconfirmed','pending']) assert.ok(safeRetryReason('needs_review',[{status}],[]))
    assert.ok(safeRetryReason('applied',[],[]))
    assert.ok(safeRetryReason('failed',[{status:'failed'}],[{state:'submitting'}]))
    assert.ok(safeRetryReason('needs_review',[{status:'needs_review'}],[{state:'submitted'}]))
  })
  it('allows explicit safe retry for pre-submit failure or cancelled queue work',()=>{
    assert.equal(safeRetryReason('closed',[],[]),null)
    assert.equal(safeRetryReason('failed',[{status:'failed'}],[{state:'opening'},{state:'failed'}]),null)
    assert.equal(safeRetryReason('needs_review',[{status:'needs_review'}],[{state:'blocked'}]),null)
    assert.ok(safeRetryReason('queued',[],[]))
  })
})
it('durable submit fence rejects retries even if all event inserts failed',()=>{
 assert.ok(safeRetryReason('failed',[{status:'failed',submitStartedAt:new Date()}],[]))
})
it('known dry-run preparation can later be retried while an unknown outcome cannot',()=>{
 assert.equal(safeRetryReason('needs_review',[{status:'unknown',error:'Not submitted: dry_run',submitStartedAt:null}],[{state:'submitting',detail:{dryRun:true}},{state:'skipped'}]),null)
 assert.ok(safeRetryReason('needs_review',[{status:'unknown',error:null}],[]))
})
