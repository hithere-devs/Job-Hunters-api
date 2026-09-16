import crypto from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { applications, jobs, kits, resumes, fieldAnswers, pendingApplicationQuestions } from '../../db/schema.js'
import { getRedis } from '../../lib/redis.js'
import { withDeadline } from '../../lib/deadline.js'
import { notFound } from '../../lib/errors.js'
import { forbiddenQuestion, looksLikeLegacyQuestion, validateLiveAnswer } from '../../hunt/apply/question-policy.js'
import { canReuseExplicitAnswer, sensitiveReason } from '../../hunt/apply/fields.js'
import { canonicalCommonQuestionKey } from '../../persona/application-questions.js'
import { resolveApplicationAnswers, type ResolvedApplicationAnswer } from '../../persona/answer-resolver.js'
import { answerQuestions, questionField } from './questions.js'

type Question=typeof pendingApplicationQuestions.$inferSelect
export function approvedResolvedAnswer(q:Question,result:ResolvedApplicationAnswer):boolean {
 if(!result.autoApply||!result.answer||!result.evidence.length||forbiddenQuestion(questionField(q)))return false
 if(result.decision==='known'&&result.confidence<.95)return false
 if(result.decision==='draft'&&(q.sensitive||sensitiveReason(q.label,q.options)||result.answer.trim().split(/\s+/).length>60))return false
 if(!['known','draft'].includes(result.decision))return false
 try{validateLiveAnswer(questionField(q),{answer:result.answer,remember:false,skip:false});return true}catch{return false}
}
async function sourceVersion(userId:string){
 const result=await db.execute(sql`select
  (select max(updated_at)::text from ${kits} where user_id=${userId}) as kit,
  (select max(updated_at)::text from ${resumes} where user_id=${userId}) as resume,
  (select max(updated_at)::text from ${fieldAnswers} where user_id=${userId} and provenance='explicit_user') as answers,
  (select max(greatest(answered_at,nullif(answer_meta->>'historicalReuseApprovedAt','')::timestamptz))::text from ${pendingApplicationQuestions} where user_id=${userId} and answer is not null and answer_meta->>'source' is distinct from 'profile_ai') as human`)
 return JSON.stringify(result.rows[0])
}
const empty=()=>({busy:false,checked:0,resolved:0,known:0,drafted:0,asked:0,skipped:0,resolutions:[] as Array<Omit<ResolvedApplicationAnswer,'answer'>>,saved:0,continuedApplicationIds:[] as string[],queuedApplicationIds:[] as string[],blockedApplications:[] as Array<{applicationId:string;reason:string}>})
export async function resolvePendingQuestions(userId:string,questionIds?:string[],options:{autoResume?:boolean;retry?:boolean;includePreviousResponses?:boolean;resolve?:typeof resolveApplicationAnswers}={}){
 const response=empty()
 const redis=getRedis(),lockKey=`huntly:answer-resolution:${userId}`,token=crypto.randomUUID()
 const acquired=await withDeadline(redis.set(lockKey,token,'PX',120_000,'NX'),3_000).catch(()=>null)
 if(acquired!=='OK')return {...response,busy:true}
 try{
  if(options.includePreviousResponses)await db.update(pendingApplicationQuestions).set({remember:true,answerMeta:sql`${pendingApplicationQuestions.answerMeta} || ${JSON.stringify({historicalReuseApprovedAt:new Date().toISOString()})}::jsonb`,updatedAt:new Date()}).where(and(eq(pendingApplicationQuestions.userId,userId),sql`${pendingApplicationQuestions.answer} is not null`,eq(pendingApplicationQuestions.remember,false),sql`${pendingApplicationQuestions.answerMeta}->>'source' is distinct from 'profile_ai'`))
  const rows=await db.select({q:pendingApplicationQuestions,role:applications.role,company:applications.company,jobUpdatedAt:jobs.updatedAt}).from(pendingApplicationQuestions)
   .innerJoin(applications,and(eq(applications.id,pendingApplicationQuestions.applicationId),eq(applications.userId,userId)))
   .leftJoin(jobs,eq(jobs.id,applications.jobId))
   .where(and(eq(pendingApplicationQuestions.userId,userId),questionIds?.length?inArray(pendingApplicationQuestions.id,[...new Set(questionIds)].slice(0,30)):and(isNull(pendingApplicationQuestions.answer),inArray(pendingApplicationQuestions.status,['pending','expired','failed'])),sql`${pendingApplicationQuestions.attemptId}=(select a.id from apply_attempts a join hunt_candidates c on c.id=a.candidate_id where a.user_id=${userId} and c.job_id=${applications.jobId} order by a.created_at desc limit 1)`))
   .orderBy(asc(pendingApplicationQuestions.createdAt)).limit(30)
  if(questionIds&&rows.length!==new Set(questionIds).size)throw notFound('One or more questions were not found in your current applications.')
  const version=await sourceVersion(userId)
  const candidates=rows.filter(({q})=>q.answer===null&&['pending','expired','failed'].includes(q.status)&&!forbiddenQuestion(questionField(q))&&(!(q.blockedReason==='legacy_metadata'||looksLikeLegacyQuestion(q))||Boolean(canonicalCommonQuestionKey(questionField(q)))))
  const claims:Array<{q:Question;fingerprint:string}>=[]
  for(const {q,role,company,jobUpdatedAt}of candidates){
   const fingerprint=crypto.createHash('sha256').update(JSON.stringify([version,q.host,canonicalCommonQuestionKey(questionField(q))??q.fieldSignature,q.options,q.required,canReuseExplicitAnswer(questionField(q))&&!q.sensitive&&!sensitiveReason(q.label,q.options)?null:[q.applicationId,role,company,jobUpdatedAt]])).digest('hex')
   if(!options.retry&&q.answerMeta.fingerprint===fingerprint){response.skipped++;continue}
   const [claimed]=await db.update(pendingApplicationQuestions).set({answerMeta:{source:'profile_ai',resolutionStatus:'running',fingerprint,startedAt:new Date().toISOString(),token},updatedAt:new Date()})
    .where(and(eq(pendingApplicationQuestions.id,q.id),isNull(pendingApplicationQuestions.answer),eq(pendingApplicationQuestions.status,q.status),sql`${pendingApplicationQuestions.answerMeta}=${JSON.stringify(q.answerMeta)}::jsonb`)).returning({id:pendingApplicationQuestions.id})
   if(claimed)claims.push({q,fingerprint});else response.skipped++
  }
  if(!claims.length)return response
  const cached=await db.select().from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.userId,userId),sql`${pendingApplicationQuestions.answerMeta}->>'source'='profile_ai'`,sql`${pendingApplicationQuestions.answerMeta}->>'resolutionStatus'='complete'`,sql`${pendingApplicationQuestions.answerMeta}->>'fingerprint' in (${sql.join(claims.map(c=>sql`${c.fingerprint}`),sql`,`)})`)).orderBy(desc(pendingApplicationQuestions.updatedAt)).limit(100)
  const results:ResolvedApplicationAnswer[]=[]
  const uncached:typeof claims=[]
  for(const claim of claims){
   const hit=!options.retry?cached.find(q=>q.answerMeta.fingerprint===claim.fingerprint&&q.answer!==null):undefined
   if(hit){results.push({questionId:claim.q.id,decision:hit.answerMeta.decision as ResolvedApplicationAnswer['decision'],answer:hit.answer,confidence:Number(hit.answerMeta.confidence??0),evidence:(hit.answerMeta.evidence??[]) as ResolvedApplicationAnswer['evidence'],reason:String(hit.answerMeta.reason??'Reused a validated match to your unchanged profile sources.'),missingInfo:[],autoApply:hit.answerMeta.autoApply===true})}else uncached.push(claim)
  }
  let failedReason:string|null=null
  if(uncached.length)try{results.push(...await withDeadline((options.resolve??resolveApplicationAnswers)(userId,uncached.map(c=>c.q.id)),45_000))}catch{failedReason='AI profile checking is temporarily unavailable. Your answers were not changed; retry or answer this question.'}
  if(await sourceVersion(userId)!==version)failedReason='Your profile changed during checking. Recheck against the updated information.'
  const metadata:Record<string,Record<string,unknown>>={}
  const answers:Array<{questionId:string;answer:string;remember:boolean;skip:boolean}>=[]
  for(const {q,fingerprint}of claims){
   const result=failedReason?undefined:results.find(r=>r.questionId===q.id)
   const safe=result&&approvedResolvedAnswer(q,result)
   const info:ResolvedApplicationAnswer=result??{questionId:q.id,decision:'ask',answer:null,confidence:0,evidence:[],reason:failedReason??'No supported answer could be established from your saved facts.',missingInfo:[q.label],autoApply:false}
   const meta={source:'profile_ai',resolutionStatus:failedReason?'error':'complete',fingerprint,resolvedAt:new Date().toISOString(),decision:safe?info.decision:'ask',confidence:info.confidence,evidence:info.evidence,reason:info.reason,missingInfo:info.missingInfo,autoApply:Boolean(safe)}
   metadata[q.id]=meta
   await db.update(pendingApplicationQuestions).set({answerMeta:meta,updatedAt:new Date()}).where(and(eq(pendingApplicationQuestions.id,q.id),isNull(pendingApplicationQuestions.answer),sql`${pendingApplicationQuestions.answerMeta}->>'token'=${token}`))
   response.resolutions.push({questionId:q.id,decision:safe?info.decision:'ask',confidence:info.confidence,evidence:info.evidence,reason:info.reason,missingInfo:info.missingInfo,autoApply:Boolean(safe)})
   if(safe)answers.push({questionId:q.id,answer:info.answer!,remember:false,skip:false})
  }
  response.checked=claims.length
  if(answers.length){
   const saved=await answerQuestions(userId,answers,undefined,{source:'profile_ai',metadata,autoResume:options.autoResume})
   Object.assign(response,saved)
  }
  response.resolved=response.saved
  response.known=response.resolutions.filter(r=>r.autoApply&&r.decision==='known').length
  response.drafted=response.resolutions.filter(r=>r.autoApply&&r.decision==='draft').length
  response.asked=response.resolutions.filter(r=>!r.autoApply).length
  return response
 }finally{await withDeadline(redis.eval('if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end',1,lockKey,token),2_000).catch(()=>undefined)}
}
