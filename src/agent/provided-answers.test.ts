import assert from 'node:assert/strict'
import { it } from 'node:test'
import { providedAnswerMatches } from './provided-answers.js'
import { explicitStepLabel,authenticationPage } from './navigation-steps.js'
it('sensitive writes require an exact validated field/host/value, never a model inference',()=>{
 const field={label:'Work authorization',name:'auth',type:'radio',required:true,options:['Yes','No']}
 const answer={...field,host:'fixture.invalid',value:'No',source:'user' as const}
 assert.equal(providedAnswerMatches([answer],field,'fixture.invalid','No'),true)
 assert.equal(providedAnswerMatches([answer],field,'fixture.invalid','Yes'),false)
 assert.equal(providedAnswerMatches([answer],{...field,name:'other'},'fixture.invalid','No'),false)
 assert.equal(providedAnswerMatches([answer],field,'another.invalid','No'),false)
})
it('ambiguous final labels are not navigation-step exemptions',()=>{
 for(const label of ['Next','Next step','Back','Save and continue'])assert.equal(explicitStepLabel(label),true)
 for(const label of ['Continue','Apply','Submit application','Send'])assert.equal(explicitStepLabel(label),false)
 assert.equal(authenticationPage('https://example.com/login'),true)
 assert.equal(authenticationPage('https://accounts.google.com/v3/signin/identifier'),true)
 assert.equal(authenticationPage('https://example.com/jobs/login-engineer'),false)
})
