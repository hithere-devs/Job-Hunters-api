import assert from 'node:assert/strict'
import {test} from 'node:test'
import {sourcesForQuestion,type ResolverQuestion,type AnswerSource} from './answer-resolver-policy.js'
const question:ResolverQuestion={id:'q',applicationId:'new-app',label:'Why this company?',type:'textarea',required:true,role:'Engineer',company:'New employer',location:'India'}
const source:AnswerSource={id:'old',label:'Why this company?',text:'I want to work for the previous employer.',kind:'explicit_answer',topic:'professional',applicationId:'old-app'}
test('company-specific replies are not copied into another employer’s application',()=>assert.deepEqual(sourcesForQuestion(question,[source]),[]))
test('resume facts remain available to draft a fresh answer',()=>{const resume:AnswerSource={id:'resume',label:'Professional experience',text:'Built backend APIs using TypeScript.',kind:'resume',topic:'professional'};assert.deepEqual(sourcesForQuestion(question,[source,resume]),[resume])})
