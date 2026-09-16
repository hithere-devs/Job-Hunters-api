import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod/v4'
import { parseStructuredJson, structuredJsonInstructions, openRouterBody, openRouterCompletion, openRouterFailure, openRouterMessages, openRouterUsage } from './openrouter.js'
import { reportedOrEstimatedCost } from './meter.js'
import { ModelServiceUnavailableError } from './errors.js'

test('Gemini request keeps mandatory reasoning on even when caller asks for cheap classification',()=>{
 const body=openRouterBody({userId:null,messages:[{role:'user',content:'fixture'}],think:false,model:'google/gemini-3.5-flash'})
 assert.deepEqual(body.reasoning,{effort:'low'});assert.equal(body.model,'google/gemini-3.5-flash')
 assert.deepEqual(body.provider,{require_parameters:true})
})
test('OpenRouter history preserves tool signatures, denies remote image fetches and orphan results',()=>{
 const details=[{type:'reasoning.encrypted',data:'synthetic-signature'}]
 const messages=openRouterMessages([{role:'assistant',content:null,tool_calls:[{id:'fixture-call'}],reasoning_details:details}])
 assert.deepEqual(messages[0]?.reasoning_details,details)
 assert.throws(()=>openRouterMessages([{role:'tool',content:'orphan'}]),/missing call id/)
 assert.throws(()=>openRouterMessages([{role:'user',content:[{type:'image_url',image_url:{url:'http://127.0.0.1/private'}}]}]),/Unsupported/)
})
test('quota and authentication failures are actionable service errors, never applicant questions',()=>{
 assert.equal((openRouterFailure(402) as ModelServiceUnavailableError).reason,'provider_quota')
 assert.equal((openRouterFailure(401) as ModelServiceUnavailableError).reason,'provider_auth')
 assert.equal((openRouterFailure(429,'insufficient credits') as ModelServiceUnavailableError).reason,'provider_quota')
 assert.doesNotMatch(openRouterFailure(400,'sensitive-provider-echo').message,/sensitive-provider-echo/)
})
test('cost accounting uses finite actual provider charge including cache/reasoning',()=>{
 const usage=openRouterUsage({prompt_tokens:100,completion_tokens:200,cost:0.012345,prompt_tokens_details:{cached_tokens:50}})
 assert.equal(reportedOrEstimatedCost('google/gemini-3.5-flash',usage),0.012345)
 assert.equal(reportedOrEstimatedCost('google/gemini-3.5-flash',{input_tokens:1000000,output_tokens:1000000,cost_usd:NaN}),10.5)
 assert.equal(reportedOrEstimatedCost('google/gemini-3.5-flash',{input_tokens:1000000,cost_usd:-1}),1.5)
})
test('funding failure makes one request and records safe failure metadata without retry',async()=>{
 let requests=0,budgetChecks=0
 const recorded:unknown[]=[]
 await assert.rejects(openRouterCompletion({userId:null,messages:[{role:'user',content:'synthetic'}]}, {
  apiKey:'fixture-key',assertBudget:async()=>{budgetChecks++},record:async record=>{recorded.push(record)},
  fetch:async()=>{requests++;return new Response(JSON.stringify({error:{message:'Insufficient credits'}}),{status:402})},
 }),error=>error instanceof ModelServiceUnavailableError&&error.reason==='provider_quota')
 assert.equal(requests,1);assert.equal(budgetChecks,1)
 assert.equal((recorded[0] as {error:string}).error,'provider_quota')
})
test('tool responses preserve provider-opaque reasoning details and accurate metering',async()=>{
 const recorded:unknown[]=[]
 const details=[{type:'reasoning.encrypted',data:'synthetic-signature'}]
 const result=await openRouterCompletion({userId:null,messages:[{role:'user',content:'synthetic'}]}, {
  apiKey:'fixture-key',assertBudget:async()=>{},record:async value=>{recorded.push(value)},
  fetch:async(_url,init)=>{assert.ok(init?.signal);return new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'fixture',type:'function',function:{name:'fixture',arguments:'{}'}}],reasoning_details:details}}],usage:{prompt_tokens:10,completion_tokens:20,cost:0.000123}}),{status:200})},
 })
 assert.equal(result.toolCalls[0]?.id,'fixture');assert.deepEqual(result.reasoningDetails,details)
 assert.equal((recorded[0] as {usage:{cost_usd:number}}).usage.cost_usd,0.000123)
})

test('JSON compatibility envelope retains complete schema validation and accepts real whitespace fences',()=>{
 const schema=z.object({answer:z.string().max(4)})
 const instructions=structuredJsonInstructions(schema,{userId:null,purpose:'map-field',prompt:'synthetic'})
 assert.match(instructions,/maxLength/)
 assert.deepEqual(parseStructuredJson(schema,'```json\n{"result":{"answer":"Yes"}}\n```'),{answer:'Yes'})
 assert.throws(()=>parseStructuredJson(schema,'{"result":{"answer":"too-long"}}'))
 assert.throws(()=>parseStructuredJson(schema,'{"answer":"Yes"}'),/envelope/)
 assert.deepEqual(parseStructuredJson(z.array(z.string()),'{"result":["Yes"]}'),['Yes'])
})
test('application defaults do not clamp explicit larger structured/resume output budgets',()=>{
 const body=openRouterBody({userId:null,messages:[{role:'user',content:'synthetic resume parse'}],maxTokens:16000})
 assert.equal(body.max_tokens,16000)
})
