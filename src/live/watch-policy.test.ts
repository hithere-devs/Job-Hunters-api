import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forwardAttemptInput } from './watch-policy.js'
test('read-only watch drops click, key, scroll, release and malformed messages',()=>{
 const forwarded:unknown[]=[]
 for(const raw of ['{"kind":"click","x":1,"y":1}','{"kind":"key","text":"secret"}','{"kind":"scroll","deltaY":100}','{"kind":"release"}','bad']) assert.equal(forwardAttemptInput(true,raw,e=>forwarded.push(e)),false)
 assert.deepEqual(forwarded,[])
})
test('existing interactive takeover remains functional on its original path',()=>{
 const forwarded:unknown[]=[]
 assert.equal(forwardAttemptInput(false,'{"kind":"click","x":1,"y":1}',e=>forwarded.push(e)),true)
 assert.equal(forwarded.length,1)
})
