import { setTimeout as sleep } from 'node:timers/promises'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { Page } from 'playwright-core'
import { db } from '../../db/client.js'
import { attemptFlags,pendingApplicationQuestions } from '../../db/schema.js'
import { fieldSignature,normaliseLabel,sensitiveReason,canReuseExplicitAnswer,rememberAnswer,type FormField } from './fields.js'
import { forbiddenQuestion,readableQuestionLabel,validateLiveAnswer } from './question-policy.js'
import { readFields } from './recipes.js'
import { setValue,type FillResult } from './fill.js'
import { transition } from './state.js'
import { publishAttemptEvent } from './events.js'

export const LIVE_QUESTION_TIMEOUT_MS=10*60_000
function capturedField(q:typeof pendingApplicationQuestions.$inferSelect):FormField{return {label:q.label,type:q.type,name:q.fieldName??undefined,required:q.required,options:q.options}}
async function applyCapturedAnswer(page:Page,field:FormField,host:string,value:string){
 if(new URL(page.url()).hostname!==host)return false
 // Re-read current controls; never apply an answer to a moved/renamed field.
 const current=(await readFields(page)).find(f=>fieldSignature(f)===fieldSignature(field))
 if(!current||forbiddenQuestion(current))return false
 try{validateLiveAnswer(current,{answer:value,remember:false,skip:false})}catch{return false}
 if(!await setValue(page,current,value))return false
 // Native HTML validation catches required/pattern/range constraints. Selectors
 // are from the captured DOM name, never a selector provided by the answer.
 if(current.name){
  const escaped=current.name.replace(/\\/g,'\\\\').replace(/"/g,'\\"')
  const controls=page.locator(`[name="${escaped}"]`)
  return controls.evaluateAll(elements=>elements.every(el=>!(el instanceof HTMLInputElement||el instanceof HTMLSelectElement||el instanceof HTMLTextAreaElement)||el.validity.valid))
 }
 return true
}
/** Form answers are data; no response is sent to a model or interpreted as a browser command. */
export async function waitForApplicationAnswers(params:{page:Page;userId:string;applicationId:string;attemptId:string;unresolved:FillResult['unresolved'];optionalLabels?:string[];signal?:AbortSignal;timeoutMs?:number}):Promise<FillResult['unresolved']>{
 const {page,userId,applicationId,attemptId}=params
 const host=new URL(page.url()).hostname
 const fields=await readFields(page)
 const wanted=new Set([...params.unresolved.map(f=>normaliseLabel(f.label)),...(params.optionalLabels??[]).map(normaliseLabel)])
 const captured=fields.filter(f=>wanted.has(normaliseLabel(f.label))&&!forbiddenQuestion(f)&&readableQuestionLabel(f.label,f.options)&&!['file','hidden','button'].includes(f.type)).slice(0,30)
 if(!captured.length)return params.unresolved
 const expiresAt=new Date(Date.now()+(params.timeoutMs??LIVE_QUESTION_TIMEOUT_MS))
 for(const field of captured){
  const signature=fieldSignature(field)
  const [prior]=await db.select().from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.userId,userId),eq(pendingApplicationQuestions.applicationId,applicationId),eq(pendingApplicationQuestions.host,host),ne(pendingApplicationQuestions.attemptId,attemptId),eq(pendingApplicationQuestions.label,field.label),eq(pendingApplicationQuestions.type,field.type),inArray(pendingApplicationQuestions.status,['answered','applied','skipped']))).orderBy(desc(pendingApplicationQuestions.updatedAt)).limit(1)
  const compatible=prior&&(prior.fieldSignature===signature||(!prior.fieldName&&prior.options.length===0))
  let inherited:string|null=null
  if(compatible&&prior.answer){try{inherited=validateLiveAnswer(field,{answer:prior.answer,remember:prior.remember,skip:false})}catch{}}
  await db.insert(pendingApplicationQuestions).values({userId,applicationId,attemptId,host,fieldSignature:signature,fieldName:field.name??null,label:field.label,type:field.type,options:field.options??[],required:field.required,sensitive:Boolean(sensitiveReason(field.label,field.options)),status:inherited?'answered':compatible&&prior.status==='skipped'&&!field.required?'skipped':'pending',answer:inherited,remember:compatible?prior.remember:false,expiresAt}).onConflictDoNothing()
 }
 await transition({attemptId,userId,state:'waiting_for_input',detail:{pendingQuestions:captured.length,expiresAt:expiresAt.toISOString()}})
 while(Date.now()<expiresAt.getTime()){
  params.signal?.throwIfAborted()
  const [flag]=await db.select({id:attemptFlags.id}).from(attemptFlags).where(and(eq(attemptFlags.userId,userId),eq(attemptFlags.status,'open'))).limit(1)
  if(flag)break
  const rows=await db.select().from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.userId,userId),eq(pendingApplicationQuestions.attemptId,attemptId)))
  for(const q of rows.filter(row=>row.status==='answered')){
   const field=capturedField(q)
   const ok=q.answer!==null&&await applyCapturedAnswer(page,field,host,q.answer)
   if(ok&&q.remember&&canReuseExplicitAnswer(field)){
    try{await rememberAnswer(userId,host,field,q.answer!)}catch{await db.update(pendingApplicationQuestions).set({remember:false}).where(eq(pendingApplicationQuestions.id,q.id))}
   }
   await db.update(pendingApplicationQuestions).set({status:ok?'applied':'failed',blockedReason:ok?null:'The provider did not accept this answer or the field changed. Choose another answer.',updatedAt:new Date()}).where(and(eq(pendingApplicationQuestions.id,q.id),eq(pendingApplicationQuestions.status,'answered')))
   publishAttemptEvent(userId,{type:'field',attemptId,label:q.label,via:'cache',filled:ok})
  }
  const remaining=await db.select().from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.attemptId,attemptId),inArray(pendingApplicationQuestions.status,['pending','answered','failed'])))
  if(!remaining.length){await transition({attemptId,userId,state:'filling',detail:{humanAnswersApplied:true}});break}
  await sleep(1_000,undefined,{signal:params.signal})
 }
 await db.update(pendingApplicationQuestions).set({status:'expired',blockedReason:'The live browser wait ended. Save an answer in the question inbox to resume safely.',updatedAt:new Date()}).where(and(eq(pendingApplicationQuestions.attemptId,attemptId),inArray(pendingApplicationQuestions.status,['pending','failed'])))
 const done=await db.select().from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.attemptId,attemptId),inArray(pendingApplicationQuestions.status,['applied','skipped'])))
 const resolved=new Set(done.map(q=>normaliseLabel(q.label)))
 return params.unresolved.filter(field=>!resolved.has(normaliseLabel(field.label)))
}
