import crypto from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { db,runWithDatabase } from '../../db/client.js'
import { applications, applyAttempts, attemptEvents, huntCandidates, pendingApplicationQuestions } from '../../db/schema.js'
import { ApiError, badRequest, conflict, notFound, serviceUnavailable } from '../../lib/errors.js'
import { fieldSignature, sensitiveReason, canReuseExplicitAnswer, type FormField } from '../../hunt/apply/fields.js'
import { canonicalCommonQuestionKey,APPLY_QUESTION_SPECS } from '../../persona/application-questions.js'
import { saveCommonQuestionAnswer } from '../../persona/apply-fields.js'
import { incompleteLegacyField,looksLikeLegacyQuestion,forbiddenQuestion, readableQuestionLabel, validateLiveAnswer, type liveAnswerSchema } from '../../hunt/apply/question-policy.js'
import { safeRetryReason } from '../../hunt/application-policy.js'
import { applicationJobInfo } from '../../hunt/application-queue.js'
import { retryApplication } from './actions.js'
import type { z } from 'zod'

type Question = typeof pendingApplicationQuestions.$inferSelect
export function questionField(q:Question):FormField {return {label:q.label,type:q.type,name:q.fieldName??undefined,required:q.required,options:q.options}}
export function storedAnswerState(q:Pick<Question,'answer'|'status'|'label'|'type'|'fieldName'|'required'|'options'>){
 const answerPresent=q.answer!==null
 let answerValid=false
 if(answerPresent)try{validateLiveAnswer({label:q.label,type:q.type,name:q.fieldName??undefined,required:q.required,options:q.options},{answer:q.answer!,remember:false,skip:false});answerValid=true}catch{}
 return {answerPresent,answerValid,requiresNewAnswer:q.status!=='skipped'&&!answerValid}
}
export function questionDto(q:Question){return {id:q.id,label:q.label,kind:q.type,type:q.type,options:q.options,required:q.required,sensitive:q.sensitive,canRemember:canReuseExplicitAnswer(questionField(q)),status:q.status,expiresAt:q.expiresAt.toISOString(),blockedReason:q.blockedReason,answerSource:q.answer===null?null:(q.answerMeta.source??'user'),resolution:q.answerMeta,...storedAnswerState(q)}}

async function ownedLatest(userId:string,applicationId:string){
 const [app]=await db.select().from(applications).where(and(eq(applications.id,applicationId),eq(applications.userId,userId))).limit(1)
 if(!app)throw notFound('Application not found')
 const [attempt]=app.jobId?await db.select({attempt:applyAttempts,candidate:huntCandidates}).from(applyAttempts).innerJoin(huntCandidates,and(eq(huntCandidates.id,applyAttempts.candidateId),eq(huntCandidates.userId,userId),eq(huntCandidates.jobId,app.jobId))).where(eq(applyAttempts.userId,userId)).orderBy(desc(applyAttempts.createdAt)).limit(1):[]
 return {app,...attempt}
}
/** Legacy review rows may predate live questions. Preserve their actual readable labels, never invent options. */
async function seedLegacyQuestions(userId:string,applicationId:string){
 const {app,attempt}=await ownedLatest(userId,applicationId)
 if(!attempt||app.status!=='needs_review'||!app.jobUrl)return
 const existing=await db.select({id:pendingApplicationQuestions.id}).from(pendingApplicationQuestions).where(eq(pendingApplicationQuestions.attemptId,attempt.id)).limit(1)
 if(existing.length)return
 const unresolved=Array.isArray(attempt.unresolvedFields)?attempt.unresolvedFields as Array<Partial<FormField>>:[]
 let host:string;try{host=new URL(app.jobUrl).hostname}catch{return}
 const rows=unresolved.flatMap(raw=>{
  if(typeof raw.label!=='string'||typeof raw.type!=='string')return []
  const field:FormField={label:raw.label,type:raw.type,name:raw.name,required:incompleteLegacyField(raw)?false:raw.required!,options:Array.isArray(raw.options)?raw.options.filter(v=>typeof v==='string'):[]}
  if(forbiddenQuestion(field)||!readableQuestionLabel(field.label,field.options)||['button','account','file'].includes(field.type))return []
  return [{userId,applicationId,attemptId:attempt.id,host,fieldSignature:fieldSignature(field),fieldName:field.name??null,label:field.label,type:field.type,options:field.options??[],required:field.required,sensitive:Boolean(sensitiveReason(field.label,field.options)),status:'expired',expiresAt:new Date(),blockedReason:incompleteLegacyField(raw)?'legacy_metadata':null}]
 })
 if(rows.length)await db.insert(pendingApplicationQuestions).values(rows).onConflictDoNothing()
}
async function repairLegacyMetadata(userId:string){
 await db.update(pendingApplicationQuestions).set({required:false,blockedReason:'legacy_metadata',updatedAt:new Date()}).where(and(
  eq(pendingApplicationQuestions.userId,userId),eq(pendingApplicationQuestions.status,'expired'),
  sql`${pendingApplicationQuestions.answer} is null`,sql`${pendingApplicationQuestions.fieldName} is null`,
  sql`${pendingApplicationQuestions.options} = '[]'::jsonb`,
  sql`abs(extract(epoch from (${pendingApplicationQuestions.expiresAt}-${pendingApplicationQuestions.createdAt}))) <= 60`,
  sql`${pendingApplicationQuestions.blockedReason} is distinct from 'legacy_metadata'`,
 ))
}
function legacyNeedsCapture(q:Question){return q.blockedReason==='legacy_metadata'||looksLikeLegacyQuestion(q)}
function mayShowQuestion(q:Question){return !legacyNeedsCapture(q)||Boolean(canonicalCommonQuestionKey(questionField(q)))}
export async function listApplicationQuestions(userId:string,applicationId:string){
 await seedLegacyQuestions(userId,applicationId)
 await repairLegacyMetadata(userId)
 const {attempt,candidate}=await ownedLatest(userId,applicationId)
 if(!attempt||!candidate)return {attemptId:null,waiting:false,expiresAt:null,questions:[]}
 const rows=await db.select().from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.userId,userId),eq(pendingApplicationQuestions.attemptId,attempt.id))).orderBy(asc(pendingApplicationQuestions.createdAt))
 const runtime=await applicationJobInfo(userId,candidate.id,candidate.runId)
 return {attemptId:attempt.id,waiting:runtime.queueState==='active'&&rows.some(q=>q.status==='pending'),expiresAt:rows.find(q=>q.status==='pending')?.expiresAt.toISOString()??null,questions:rows.filter(mayShowQuestion).map(questionDto)}
}
export async function listQuestionInbox(userId:string){
 await repairLegacyMetadata(userId)
 // One latest-attempt query replaces per-application reads on every inbox poll.
 const review=await db.selectDistinctOn([applications.id],{app:applications,attempt:applyAttempts}).from(applications)
  .innerJoin(huntCandidates,and(eq(huntCandidates.userId,userId),eq(huntCandidates.jobId,applications.jobId)))
  .innerJoin(applyAttempts,and(eq(applyAttempts.candidateId,huntCandidates.id),eq(applyAttempts.userId,userId)))
  .where(and(eq(applications.userId,userId),eq(applications.status,'needs_review'))).orderBy(applications.id,desc(applyAttempts.createdAt)).limit(100)
 const existing=review.length?await db.selectDistinct({attemptId:pendingApplicationQuestions.attemptId}).from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.userId,userId),inArray(pendingApplicationQuestions.attemptId,review.map(r=>r.attempt.id)))):[]
 const seeded=new Set(existing.map(q=>q.attemptId))
 const legacyRows=review.flatMap(({app,attempt})=>{
  if(seeded.has(attempt.id)||!app.jobUrl)return []
  let host:string;try{host=new URL(app.jobUrl).hostname}catch{return []}
  const unresolved=Array.isArray(attempt.unresolvedFields)?attempt.unresolvedFields as Array<Partial<FormField>>:[]
  return unresolved.flatMap(raw=>{
   if(typeof raw.label!=='string'||typeof raw.type!=='string')return []
   const field:FormField={label:raw.label,type:raw.type,name:raw.name,required:incompleteLegacyField(raw)?false:raw.required!,options:Array.isArray(raw.options)?raw.options.filter(v=>typeof v==='string'):[]}
   if(forbiddenQuestion(field)||!readableQuestionLabel(field.label,field.options)||['button','account','file'].includes(field.type))return []
   return [{userId,applicationId:app.id,attemptId:attempt.id,host,fieldSignature:fieldSignature(field),fieldName:field.name??null,label:field.label,type:field.type,options:field.options??[],required:field.required,sensitive:Boolean(sensitiveReason(field.label,field.options)),status:'expired',expiresAt:new Date(),blockedReason:incompleteLegacyField(raw)?'legacy_metadata':null}]
  })
 })
 if(legacyRows.length)await db.insert(pendingApplicationQuestions).values(legacyRows).onConflictDoNothing()
 const rows=await db.select({question:pendingApplicationQuestions,role:applications.role,company:applications.company}).from(pendingApplicationQuestions).innerJoin(applications,and(eq(applications.id,pendingApplicationQuestions.applicationId),eq(applications.userId,userId)))
  .where(and(eq(pendingApplicationQuestions.userId,userId),inArray(pendingApplicationQuestions.status,['pending','expired','failed','answered']),sql`${pendingApplicationQuestions.attemptId} = (select a.id from ${applyAttempts} a join ${huntCandidates} c on c.id=a.candidate_id where a.user_id=${userId} and c.job_id=${applications.jobId} order by a.created_at desc limit 1)`)).orderBy(asc(pendingApplicationQuestions.createdAt)).limit(300)
 const groups=new Map<string,ReturnType<typeof questionDto>&{key:string;host:string;questions:Array<{id:string;applicationId:string;attemptId:string;status:string;expiresAt:string;role:string;company:string;answerPresent:boolean;answerValid:boolean;requiresNewAnswer:boolean}>;applicationIds:string[]}>()
 for(const {question:q,role,company} of rows){
  if(!mayShowQuestion(q))continue
  const commonKey=canonicalCommonQuestionKey(questionField(q))
  const key=crypto.createHash('sha256').update(JSON.stringify(commonKey?['common-profile',commonKey]:[q.host,q.fieldSignature,q.options,q.required,q.sensitive,canReuseExplicitAnswer(questionField(q))?null:q.applicationId])).digest('hex').slice(0,24)
  const group=groups.get(key)??{...questionDto(q),required:q.required&&!legacyNeedsCapture(q),label:commonKey?APPLY_QUESTION_SPECS.find(spec=>spec.id===commonKey)?.label??q.label:q.label,key,host:commonKey?'profile':q.host,questions:[],applicationIds:[]}
  group.required ||= q.required && !legacyNeedsCapture(q)
  group.requiresNewAnswer ||= storedAnswerState(q).requiresNewAnswer
  group.answerPresent ||= storedAnswerState(q).answerPresent
  group.questions.push({id:q.id,applicationId:q.applicationId,attemptId:q.attemptId,status:q.status,expiresAt:q.expiresAt.toISOString(),role,company,...storedAnswerState(q)});group.applicationIds=[...new Set([...group.applicationIds,q.applicationId])];groups.set(key,group)
 }
 const blockedApplications:Array<{applicationId:string;reason:string;canRecoverQuestions:boolean}>=[]
 const events=review.length?await db.select({attemptId:attemptEvents.attemptId,state:attemptEvents.state,detail:attemptEvents.detail}).from(attemptEvents).where(inArray(attemptEvents.attemptId,review.map(r=>r.attempt.id))):[]
 for(const {app,attempt} of review){
  const reason=safeRetryReason('needs_review',[attempt],events.filter(event=>event.attemptId===attempt.id))
  const appQuestions=rows.filter(row=>row.question.applicationId===app.id)
  const needsCapture=!appQuestions.length||appQuestions.some(row=>legacyNeedsCapture(row.question)||(['radio','select','select-one'].includes(row.question.type)&&row.question.options.length===0))
  if(reason||needsCapture)blockedApplications.push({applicationId:app.id,reason:reason??'Readable questions and exact options need to be loaded from the provider browser.',canRecoverQuestions:!reason&&needsCapture})
 }
 const inferredAnswers=await db.select({id:pendingApplicationQuestions.id,label:pendingApplicationQuestions.label,answer:pendingApplicationQuestions.answer,answerMeta:pendingApplicationQuestions.answerMeta,updatedAt:pendingApplicationQuestions.updatedAt,company:applications.company,role:applications.role})
  .from(pendingApplicationQuestions).innerJoin(applications,and(eq(applications.id,pendingApplicationQuestions.applicationId),eq(applications.userId,userId)))
  .where(and(eq(pendingApplicationQuestions.userId,userId),sql`${pendingApplicationQuestions.answer} is not null`,sql`${pendingApplicationQuestions.answerMeta}->>'source'='profile_ai'`))
  .orderBy(desc(pendingApplicationQuestions.updatedAt)).limit(20)
 return {groups:[...groups.values()],blockedApplications,inferredAnswers:inferredAnswers.map(row=>({id:row.id,label:row.label,answer:row.answer!,company:row.company,role:row.role,reason:String(row.answerMeta.reason??'Inferred from your saved profile'),at:row.updatedAt.toISOString()}))}
}
export type AnswerInput=z.infer<typeof liveAnswerSchema>&{questionId:string}
export interface AnswerWriteContext {source:'profile_ai';metadata:Record<string,Record<string,unknown>>;autoResume?:boolean}
export async function answerQuestions(userId:string,answers:AnswerInput[],applicationId?:string,context?:AnswerWriteContext){
 if(!answers.length||answers.length>500)throw badRequest('Answer between 1 and 500 questions.')
 if(Buffer.byteLength(JSON.stringify(answers),'utf8')>750_000)throw badRequest('These answers exceed the 750 KB batch limit. Save a smaller set of applications together.')
 const ids=[...new Set(answers.map(a=>a.questionId))]
 if(ids.length!==answers.length)throw badRequest('Each question may be answered once per request.')
 const rows=await db.select().from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.userId,userId),inArray(pendingApplicationQuestions.id,ids),sql`${pendingApplicationQuestions.attemptId} = (select a.id from ${applyAttempts} a join ${huntCandidates} c on c.id=a.candidate_id join ${applications} app on app.job_id=c.job_id where app.id=${pendingApplicationQuestions.applicationId} and app.user_id=${userId} and a.user_id=${userId} order by a.created_at desc limit 1)`))
 if(rows.length!==ids.length||rows.some(q=>applicationId&&q.applicationId!==applicationId))throw notFound('One or more questions were not found in this application.')
 // Validate the entire request before any write, including ownership and exact options.
 const patches:Array<{q:Question;input:AnswerInput;value:string|null}>=[]
 for(const q of rows){
  const input={...answers.find(a=>a.questionId===q.id)!}
  if(context?.source==='profile_ai'){
   if(q.answer!==null||!['pending','expired','failed'].includes(q.status))throw conflict('A user or runner answered this question while profile resolution was running.')
   input.remember=false
  }
  let value:string|null;try{value=validateLiveAnswer(questionField(q),input)}catch(error){throw badRequest(error instanceof Error?error.message:'Invalid answer')}
  if(['applied','skipped'].includes(q.status)){if(q.answer===value&&q.remember===input.remember)continue;throw conflict('This answer has already been used by the runner.')}
  patches.push({q,input,value})
 }
 const commonValues=new Map<string,string>()
 for(const {q,input,value} of patches){
  const key=canonicalCommonQuestionKey(questionField(q))
  if(!key||!input.remember||value===null)continue
  if(commonValues.has(key)&&commonValues.get(key)!==value)throw badRequest('Choose one consistent value for each shared profile field when remembering answers.')
  commonValues.set(key,value)
 }
 if(patches.length)try{
  await db.transaction(tx=>runWithDatabase(tx,async()=>{
   const answerCases=sql.join(patches.map(({q,value})=>sql`when ${q.id}::uuid then ${value}::text`),sql` `)
   const rememberCases=sql.join(patches.map(({q,input})=>sql`when ${q.id}::uuid then ${input.remember}::boolean`),sql` `)
   const statusCases=sql.join(patches.map(({q,input})=>sql`when ${q.id}::uuid then ${input.skip?'skipped':'answered'}::text`),sql` `)
   const metaCases=sql.join(patches.map(({q})=>sql`when ${q.id}::uuid then ${JSON.stringify(context?.source==='profile_ai'?{...context.metadata[q.id],source:'profile_ai'}:{source:'user',resolvedAt:new Date().toISOString()})}::jsonb`),sql` `)
   const expected=sql.join(patches.map(({q})=>sql`(${pendingApplicationQuestions.id}=${q.id}::uuid and ${pendingApplicationQuestions.status}=${q.status})`),sql` or `)
   const updated=await tx.update(pendingApplicationQuestions).set({answer:sql`case ${pendingApplicationQuestions.id} ${answerCases} end`,remember:sql`case ${pendingApplicationQuestions.id} ${rememberCases} end`,status:sql`case ${pendingApplicationQuestions.id} ${statusCases} end`,answerMeta:sql`case ${pendingApplicationQuestions.id} ${metaCases} end`,answeredAt:new Date(),updatedAt:new Date(),blockedReason:sql`case when ${pendingApplicationQuestions.blockedReason}='legacy_metadata' then 'legacy_metadata' else null end`})
    .where(and(eq(pendingApplicationQuestions.userId,userId),sql`(${expected})`)).returning({id:pendingApplicationQuestions.id})
   if(updated.length!==patches.length)throw conflict('A question changed while saving. Refresh before answering again.')
   for(const [key,value] of commonValues){const {q}=patches.find(patch=>canonicalCommonQuestionKey(questionField(patch.q))===key)!;await saveCommonQuestionAnswer(userId,questionField(q),value)}
  }))
 }catch(error){
  if(error instanceof ApiError)throw error
  // Driver errors include SQL parameters, which contain private answers.
  throw serviceUnavailable('Could not save these answers. Nothing was queued; try again.')
 }
 if(context?.autoResume===false)return {saved:patches.length,continuedApplicationIds:[],queuedApplicationIds:[],blockedApplications:[]}
 const continuedApplicationIds:string[]=[],queuedApplicationIds:string[]=[],blockedApplications:Array<{applicationId:string;reason:string}>=[]
 for(const id of [...new Set(rows.map(q=>q.applicationId))]){
  const {app,attempt,candidate}=await ownedLatest(userId,id)
  if(!candidate)continue
  const runtime=await applicationJobInfo(userId,candidate.id,candidate.runId)
  if(runtime.queueState==='active'){continuedApplicationIds.push(id);continue}
  const [uncaptured]=await db.select({id:pendingApplicationQuestions.id}).from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.applicationId,id),eq(pendingApplicationQuestions.attemptId,attempt!.id),eq(pendingApplicationQuestions.blockedReason,'legacy_metadata'))).limit(1)
  if(uncaptured){blockedApplications.push({applicationId:id,reason:'Answers saved. Load the provider questions to verify the actual options before resuming.'});continue}
  const unanswered=await db.select({id:pendingApplicationQuestions.id}).from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.applicationId,id),eq(pendingApplicationQuestions.attemptId,attempt!.id),eq(pendingApplicationQuestions.required,true),inArray(pendingApplicationQuestions.status,['pending','expired','failed']))).limit(1)
  if(unanswered.length)continue
  try{await retryApplication(userId,id);queuedApplicationIds.push(id)}catch(error){blockedApplications.push({applicationId:id,reason:error instanceof Error?error.message:'This application cannot be safely resumed automatically.'})}
 }
 return {saved:patches.length,continuedApplicationIds,queuedApplicationIds,blockedApplications}
}
