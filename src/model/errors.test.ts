import test from 'node:test'
import assert from 'node:assert/strict'
import {modelServiceFailure,ModelServiceUnavailableError} from './errors.js'
test('provider credit and auth failures stop instead of asking the applicant',()=>{
 assert.equal(modelServiceFailure(new Error('Your credit balance is too low to access the Anthropic API.'))?.reason,'provider_quota')
 assert.equal(modelServiceFailure({message:'insufficient_quota'})?.reason,'provider_quota')
 assert.equal(modelServiceFailure('authentication_error: invalid x-api-key')?.reason,'provider_auth')
 assert.equal(modelServiceFailure('request timed out'),null)
 assert.equal(modelServiceFailure('429 rate_limit_error: requests per minute exceeded'),null)
})
test('provider failure messages never echo raw upstream secrets or request bodies',()=>{
 const error=modelServiceFailure('invalid api-key SECRET_VALUE request body PERSONAL_DATA')
 assert.ok(error instanceof ModelServiceUnavailableError)
 assert.doesNotMatch(error.message,/SECRET_VALUE|PERSONAL_DATA/)
 assert.equal(modelServiceFailure(error),error)
})
