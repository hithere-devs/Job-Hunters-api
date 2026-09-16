import assert from 'node:assert/strict'
import { it } from 'node:test'
import { storedAnswerState } from './questions.js'
const question={label:'Do you require sponsorship?',type:'checkbox',fieldName:null,required:false,options:[],status:'expired'}
it('an expired saved boolean is known information, not an unanswered question',()=>{
 for(const answer of ['true','false'])assert.deepEqual(storedAnswerState({...question,answer}),{answerPresent:true,answerValid:true,requiresNewAnswer:false})
})
it('failed browser interactions do not erase a valid saved answer',()=>{
 assert.equal(storedAnswerState({...question,status:'failed',answer:'false'}).requiresNewAnswer,false)
 assert.equal(storedAnswerState({...question,answer:null}).requiresNewAnswer,true)
})
it('changed provider options require clarification without pretending the previous answer vanished',()=>{
 assert.deepEqual(storedAnswerState({...question,type:'radio',options:['Yes','No'],answer:'false'}),{answerPresent:true,answerValid:false,requiresNewAnswer:true})
})
