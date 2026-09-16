import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectedApplicationStatus } from './runtime.js'
test('backfill never claims a queued or unfinished job was submitted',()=>{
 for(const status of ['approved','queued','tailored','applying']) assert.equal(projectedApplicationStatus(status),'queued')
 assert.equal(projectedApplicationStatus('needs_review'),'needs_review')
 assert.equal(projectedApplicationStatus('failed'),'failed')
 assert.equal(projectedApplicationStatus('applied'),'applied')
})
