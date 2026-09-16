import { setTimeout as sleep } from 'node:timers/promises'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { Page } from 'playwright-core'
import { canonicalCommonQuestionKey } from '../../persona/application-questions.js'
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
export async function waitForApplicationAnswers(params:{page:Page;userId:string;applicationId:string;attemptId:string;unresolved:FillResult['unresolved'];optionalLabels?:string[];signal?:AbortSignal;timeoutMs?:number;resolveWithProfile?:boolean;waitForHuman?:boolean}):Promise<FillResult['unresolved']>{
 const {page,userId,applicationId,attemptId}=params
 const captureUrl=page.url()
 const host=new URL(captureUrl).hostname
 const fields=await readFields(page)
 const wanted=new Set([...params.unresolved.map(f=>normaliseLabel(f.label)),...(params.optionalLabels??[]).map(normaliseLabel)])
 const captured=fields.filter(f=>wanted.has(normaliseLabel(f.label))&&!forbiddenQuestion(f)&&readableQuestionLabel(f.label,f.options)&&!['file','hidden','button'].includes(f.type)).slice(0,30)
 if(!captured.length)return params.unresolved
 const forms=await page.locator('form').elementHandles()
 const conditionalHidden=async(field:FormField)=>{
  if(!field.name||page.url()!==captureUrl)return false
  for(const form of forms){
   const hidden=await form.evaluate((node,name)=>{
    if(!(node instanceof HTMLFormElement)||!node.isConnected)return false
    const formStyle=getComputedStyle(node)
    if(formStyle.display==='none'||formStyle.visibility==='hidden')return false
    const controls=Array.from(node.querySelectorAll<HTMLInputElement>('input,select,textarea')).filter(control=>control.name===name)
    if(!controls.length)return false
    return controls.every(control=>{
     for(let parent:HTMLElement|null=control;parent&&parent!==node;parent=parent.parentElement){
      if(parent===control&&['radio','checkbox'].includes(control.type))continue
      const style=getComputedStyle(parent)
      if(parent.hidden||parent.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return true
     }
     return false
    })
   },field.name).catch(()=>false)
   if(hidden)return true
  }
  return false
 }

 const expiresAt=new Date(Date.now()+(params.timeoutMs??LIVE_QUESTION_TIMEOUT_MS))
 /**
  * Prior answers, across every application this user has ever made.
  *
  * This used to be scoped by `applicationId`, which meant an answer was only
  * ever reused inside the job it was given for. "What is your location?" was
  * asked again on the next posting, and the one after that — so every single
  * application stopped and waited for a human, and applying unattended was
  * impossible by construction.
  *
  * Reuse is still gated: `validateLiveAnswer` below re-checks the stored answer
  * against *this* field's current options, so a stale or mismatched answer
  * becomes a question again rather than being forced in.
  */
 const priorRows=await db.select().from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.userId,userId),ne(pendingApplicationQuestions.attemptId,attemptId),inArray(pendingApplicationQuestions.status,['answered','applied','skipped']))).orderBy(desc(pendingApplicationQuestions.updatedAt)).limit(400)
 const plainLabel=(value:string)=>normaliseLabel(value).toLowerCase().replace(/\s*[-–—]\s*no fact provided$/i,'')
 for(const field of captured){
  const signature=fieldSignature(field)
  const commonKey=canonicalCommonQuestionKey(field)
  const label=plainLabel(field.label)
  const matches=(q:typeof priorRows[number])=>q.fieldSignature===signature || ((!q.fieldName&&q.options.length===0)&&(plainLabel(q.label)===label || (commonKey&&canonicalCommonQuestionKey(capturedField(q))===commonKey)))
  // Same host first — an option list is a property of the form, not of the
  // question. Only carry an answer to a different host when it is a question
  // we recognise generically, or plain free text with no options to mismatch.
  const prior=priorRows.find(q=>q.host===host&&matches(q))
   ?? priorRows.find(q=>q.host!==host&&matches(q)&&(Boolean(commonKey)||((field.options??[]).length===0&&q.options.length===0)))
  let inherited:string|null=null
  if(prior?.answer){try{inherited=validateLiveAnswer(field,{answer:prior.answer,remember:prior.remember,skip:false})}catch{}}
  // Remembering is the default for anything safe to reuse. Defaulting to false
  // meant a user had to opt in per question, and almost nobody does — so the
  // long-term `field_answers` cache stayed empty and every answer was thrown
  // away the moment the application finished. Sensitive questions are excluded
  // here exactly as they are everywhere else.
  const sensitive=Boolean(sensitiveReason(field.label,field.options))
  const remember=prior?.answerMeta.source==='profile_ai'?false:(prior?.remember??(!sensitive&&canReuseExplicitAnswer(field)))
  await db.insert(pendingApplicationQuestions).values({userId,applicationId,attemptId,host,fieldSignature:signature,fieldName:field.name??null,label:field.label,type:field.type,options:field.options??[],required:field.required,sensitive,status:inherited?'answered':prior?.status==='skipped'&&!field.required?'skipped':'pending',answer:inherited,remember,answerMeta:inherited?(prior?.answerMeta??{}):{},expiresAt,blockedReason:prior?.answer&&!inherited?'Your previous answer is saved, but does not match the provider’s current options. Please confirm a choice for this exact question.':null}).onConflictDoNothing()
 }
 if(params.resolveWithProfile!==false){
  await transition({attemptId,userId,state:'resolving_answers',detail:{questionCount:captured.length}})
  const pending=await db.select({id:pendingApplicationQuestions.id}).from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.attemptId,attemptId),eq(pendingApplicationQuestions.status,'pending')))
  if(pending.length){
   const {resolvePendingQuestions}=await import('../../modules/applications/question-resolution.js')
   await resolvePendingQuestions(userId,pending.map(q=>q.id),{autoResume:false}).catch(()=>undefined)
  }
 }
 if(params.waitForHuman!==false)await transition({attemptId,userId,state:'waiting_for_input',detail:{pendingQuestions:captured.length,expiresAt:expiresAt.toISOString()}})
 while(Date.now()<expiresAt.getTime()){
  params.signal?.throwIfAborted()
  const [flag]=await db.select({id:attemptFlags.id}).from(attemptFlags).where(and(eq(attemptFlags.userId,userId),eq(attemptFlags.status,'open'))).limit(1)
  if(flag)break
  const rows=await db.select().from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.userId,userId),eq(pendingApplicationQuestions.attemptId,attemptId)))
  for(const q of rows.filter(row=>row.status==='answered')){
   const field=capturedField(q)
   if(await conditionalHidden(field)){await db.update(pendingApplicationQuestions).set({status:'skipped',blockedReason:'No longer required for your current answers.',updatedAt:new Date()}).where(eq(pendingApplicationQuestions.id,q.id));continue}
   const ok=q.answer!==null&&await applyCapturedAnswer(page,field,host,q.answer)
   if(ok&&q.remember&&q.answerMeta.source!=='profile_ai'&&canReuseExplicitAnswer(field)){
    try{await rememberAnswer(userId,host,field,q.answer!)}catch{await db.update(pendingApplicationQuestions).set({remember:false}).where(eq(pendingApplicationQuestions.id,q.id))}
   }
   await db.update(pendingApplicationQuestions).set({status:ok?'applied':'failed',blockedReason:ok?null:'The provider did not accept this answer or the field changed. Choose another answer.',updatedAt:new Date()}).where(and(eq(pendingApplicationQuestions.id,q.id),eq(pendingApplicationQuestions.status,'answered')))
   publishAttemptEvent(userId,{type:'field',attemptId,label:q.label,via:'cache',filled:ok})
  }
  for(const q of rows.filter(row=>['pending','failed'].includes(row.status))){
   if(await conditionalHidden(capturedField(q)))await db.update(pendingApplicationQuestions).set({status:'skipped',blockedReason:'No longer required for your current answers.',updatedAt:new Date()}).where(and(eq(pendingApplicationQuestions.id,q.id),inArray(pendingApplicationQuestions.status,['pending','failed'])))
  }
  const remaining=await db.select().from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.attemptId,attemptId),inArray(pendingApplicationQuestions.status,['pending','answered','failed'])))
  if(!remaining.length){await transition({attemptId,userId,state:'filling',detail:{humanAnswersApplied:true}});break}
  if(params.waitForHuman===false)break
  await sleep(1_000,undefined,{signal:params.signal})
 }
 if(params.waitForHuman!==false)await db.update(pendingApplicationQuestions).set({status:'expired',blockedReason:sql`coalesce(${pendingApplicationQuestions.blockedReason}, 'The live browser wait ended. Saved answers remain available for safe recovery.')`,updatedAt:new Date()}).where(and(eq(pendingApplicationQuestions.attemptId,attemptId),inArray(pendingApplicationQuestions.status,['pending','failed'])))
 const done=await db.select().from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.attemptId,attemptId),inArray(pendingApplicationQuestions.status,['applied','skipped'])))
 const resolved=new Set(done.map(q=>normaliseLabel(q.label)))
 for(const form of forms)await form.dispose().catch(()=>undefined)
 return params.unresolved.filter(field=>!resolved.has(normaliseLabel(field.label)))
}
