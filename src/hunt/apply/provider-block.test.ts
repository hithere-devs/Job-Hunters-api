import test from 'node:test'
import assert from 'node:assert/strict'
import {providerSubmissionBlocked}from'./provider-block.js'
test('recognizes the explicit Ashby post-submit spam rejection',()=>{
 assert.equal(providerSubmissionBlocked("We couldn't submit your application. Your application submission was flagged as possible spam. If you believe this was a mistake, please submit your application again."),true)
 assert.equal(providerSubmissionBlocked('We couldn’t submit your application\nYour application submission was flagged as possible spam.'),true)
})
test('does not turn ordinary job copy or unconfirmed submission into a provider block',()=>{
 for(const body of ['Build spam detection systems. Submit your application','Your application was submitted successfully.','Something went wrong. Please try again.'])assert.equal(providerSubmissionBlocked(body),false)
})
