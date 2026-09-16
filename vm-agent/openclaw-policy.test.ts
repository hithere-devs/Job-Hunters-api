import test from 'node:test'
import assert from 'node:assert/strict'
import {validateOpenClawPolicy,validAttemptId} from './openclaw-policy.ts'
const good=()=>({attemptId:'00000000-0000-4000-8000-000000000001',targetId:'A'.repeat(32),deadlineEpoch:2000,allowedHosts:['jobs.ashbyhq.com'],approvedFields:[{label:'Name',type:'text',value:'Fixture'}],resumePath:'/home/huntly-u9/run/huntly-resume.pdf'})
test('accepts bounded policy for current tenant',()=>assert.equal(validateOpenClawPolicy(good(),9,1000),null))
test('rejects another tenant resume and arbitrary paths',()=>{for(const resumePath of ['/home/huntly-u3/run/huntly-resume.pdf','/etc/passwd','/home/huntly-u9/run/../profile/Cookies'])assert.equal(validateOpenClawPolicy({...good(),resumePath},9,1000),'invalid_resume_path')})
test('rejects expired or excessively long authority',()=>{for(const deadlineEpoch of [0,1000,9999999,1.5])assert.equal(validateOpenClawPolicy({...good(),deadlineEpoch},9,1000),'invalid_policy_target_or_deadline')})
test('rejects invalid host, target and attempt identifiers',()=>{assert.equal(validAttemptId('../x'),false);assert.equal(validAttemptId('-'.repeat(36)),false);assert.equal(validateOpenClawPolicy({...good(),allowedHosts:['https://example.com']},9,1000),'invalid_policy_hosts');assert.equal(validateOpenClawPolicy({...good(),targetId:'anything'},9,1000),'invalid_policy_target_or_deadline')})
test('bounds stored field payload',()=>assert.equal(validateOpenClawPolicy({...good(),approvedFields:[{label:'Name',type:'text',value:'x'.repeat(4001)}]},9,1000),'invalid_policy_fields'))
