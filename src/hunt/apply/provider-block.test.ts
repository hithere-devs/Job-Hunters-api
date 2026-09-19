import test from 'node:test'
import assert from 'node:assert/strict'
import {providerSubmissionBlocked, providerValidationFailed}from'./provider-block.js'
test('recognizes the explicit Ashby post-submit spam rejection',()=>{
 assert.equal(providerSubmissionBlocked("We couldn't submit your application. Your application submission was flagged as possible spam. If you believe this was a mistake, please submit your application again."),true)
 assert.equal(providerSubmissionBlocked('We couldn’t submit your application\nYour application submission was flagged as possible spam.'),true)
})
test('does not turn ordinary job copy or unconfirmed submission into a provider block',()=>{
 for(const body of ['Build spam detection systems. Submit your application','Your application was submitted successfully.','Something went wrong. Please try again.'])assert.equal(providerSubmissionBlocked(body),false)
})
test('treats Ashby and Greenhouse validation banners as a failed fill, not a submission',()=>{
 assert.equal(providerValidationFailed('Your form needs corrections'),true)
 assert.equal(providerValidationFailed('Missing entry for required field: Location'),true)
 assert.equal(providerValidationFailed('This field is required'),true)
 assert.equal(providerValidationFailed('Thank you for your application'),false)
})
test('Greenhouse 8-character human check is a failed fill, not a submit fence',()=>{
 assert.equal(providerValidationFailed("A verification code was sent to mywritingfrenzy@gmail.com. To submit your application, enter the 8-character code to confirm you're a human."),true)
})
test('Greenhouse processing error is a failed fill, not a thank-you',()=>{
 assert.equal(providerValidationFailed('There was an error processing your application. Please try again.'),true)
})
