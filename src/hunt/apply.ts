import os from 'node:os'
import {ModelServiceUnavailableError} from '../model/errors.js'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Page } from 'playwright-core'
import { db } from '../db/client.js'
import {
  applications,
  applyAttempts,
  attemptFlags,
  attemptEvents,
  pendingApplicationQuestions,
  huntCandidates,
  huntRunJobs,
  huntRuns,
  jobSources,
  jobs,
  resumeVariants,
  userBrowserSessions,
  type HuntRunJob,
} from '../db/schema.js'
import { browserProvider, env, hasApplyAgent } from '../config/env.js'
import { badRequest, notFound, ApiError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { buildObjectKey, downloadObject, uploadObject } from '../lib/storage.js'
import { openSession } from '../browser/session.js'
import { profileFor } from '../browser/profiles.js'
import { applyWithAgent } from '../agent/apply.js'
import { factsForAgent } from '../agent/apply.js'
import { skillForUrl } from '../skills/registry.js'
import type { ProvidedFormAnswer } from '../agent/provided-answers.js'
import { forbiddenQuestion } from './apply/question-policy.js'
import { normaliseLabel } from './apply/fields.js'
import { normaliseHttpUrl } from './apply/urls.js'
import { loadPortalProfile } from './portal-profile.js'
import { provisionPortalAccount } from './portal-accounts.js'
import { createMinimalResumeVariant } from './tailoring.js'
import { fillForm, hasSubmitControl, hasSubmissionConfirmation, submitForm } from './apply/fill.js'
import { countryCodeFor } from './apply/work-authorisation.js'
import { applyWithOpenClaw, loadOpenClawDossier, OpenClawApplyError, verifyOpenClawFilledFields } from './apply/openclaw-apply.js'
import { uploadTenantResume,installOpenClawPolicy,revokeOpenClawPolicy } from '../browser/vm-client.js'
import { parseVmProfile } from '../browser/profile-policy.js'
import { ApplicationDeferredError } from './application-policy.js'
import { publishAttemptEvent } from './apply/events.js'
import { waitForApplicationAnswers } from './apply/live-questions.js'
import { beforeSubmission, noteUnexpectedSubmission, submissionWasAttempted, withSubmissionGuard } from './apply/submission-guard.js'
import { transition } from './apply/state.js'
import { awaitTakeover, isWatched, startScreencast } from './apply/screencast.js'


async function setRunJobStatus(runId: string, jobId: string, status: HuntRunJob['status']): Promise<void> {
  await db
    .update(huntRunJobs)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(huntRunJobs.runId, runId), eq(huntRunJobs.jobId, jobId)))
}




async function persistEvidence(userId: string, attemptId: string, page: Page): Promise<string> {
  const screenshot = await page.screenshot({ fullPage: true, type: 'png' })
  const key = buildObjectKey(userId, 'application-evidence', `${attemptId}.png`)
  await uploadObject({ key, body: Buffer.from(screenshot), mimeType: 'image/png' })
  return key
}

export async function applyApprovedCandidate(
  userId: string,
  candidateId: string,
  options?: { dryRun?: boolean; signal?: AbortSignal },
): Promise<void> {
  let fenceAttemptId: string | null = null
  let submissionConfirmed = false
  return withSubmissionGuard(async () => {
  options?.signal?.throwIfAborted()
  const useOpenClaw = env.APPLY_DRIVER === 'openclaw'
  const hasReasoningDriver = hasApplyAgent || useOpenClaw
  if(!(options?.dryRun??env.APPLY_DRY_RUN)&&!hasReasoningDriver)throw badRequest('The autonomous browser model is not configured. No live application can be submitted until it is available.')
  const [candidateState] = await db
    .select({ resumeVariantId: huntCandidates.resumeVariantId, runId: huntCandidates.runId })
    .from(huntCandidates)
    .where(and(eq(huntCandidates.id, candidateId), eq(huntCandidates.userId, userId)))
    .limit(1)
  if (!candidateState) throw notFound('Approved candidate not found')
  const [runState] = await db
    .select({ status: huntRuns.status })
    .from(huntRuns)
    .where(eq(huntRuns.id, candidateState.runId))
    .limit(1)
  if (!runState || runState.status === 'stopped' || runState.status === 'failed') return
  if (!candidateState.resumeVariantId) await createMinimalResumeVariant(userId, candidateId)
  const [row] = await db
    .select({ candidate: huntCandidates, job: jobs, variant: resumeVariants })
    .from(huntCandidates)
    .innerJoin(jobs, eq(huntCandidates.jobId, jobs.id))
    .innerJoin(resumeVariants, eq(huntCandidates.resumeVariantId, resumeVariants.id))
    .where(and(eq(huntCandidates.id, candidateId), eq(huntCandidates.userId, userId)))
    .limit(1)
  if (!row) throw notFound('Approved candidate or resume variant not found')
  if (
    row.candidate.status !== 'tailored'
    && row.candidate.status !== 'queued'
    && row.candidate.status !== 'applying'
  ) {
    throw badRequest('Candidate is not approved for application.')
  }

  const [source] = await db
    .select()
    .from(jobSources)
    .where(and(eq(jobSources.jobId, row.job.id), eq(jobSources.portalId, row.candidate.sourcePortal)))
    .limit(1)
  const applyUrl = normaliseHttpUrl(row.job.applyUrl ?? source?.applyUrl ?? row.job.canonicalUrl)
  const host = new URL(applyUrl).hostname.toLowerCase()
  if (host.includes('wellfound.com') || host.includes('instahyre.com')) {
    const portal = host.includes('wellfound.com') ? 'wellfound' : 'instahyre'
    const account = await provisionPortalAccount(userId, portal)
    if (account.status !== 'ready') {
      await db.update(applications).set({status:'needs_review',notes:account.actionRequired ?? 'Connect and verify the provider account.',updatedAt:new Date()}).where(and(eq(applications.userId,userId),eq(applications.jobId,row.job.id)))
      await db
        .update(huntCandidates)
        .set({ status: 'needs_review', updatedAt: new Date() })
        .where(eq(huntCandidates.id, candidateId))
      await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'needs_review')
      await db.insert(applyAttempts).values({
        candidateId,
        userId,
        portalId: portal,
        status: 'needs_review',
        unresolvedFields: [{ label: account.actionRequired ?? 'Complete portal account verification', type: 'account' }],
        completedAt: new Date(),
      })
      return
    }
  }

  const profile = await loadPortalProfile(userId)
  let [application] = await db
    .insert(applications)
    .values({
      userId,
      jobId: row.job.id,
      role: row.job.title,
      company: row.job.company,
      location: (row.job.locations as Array<{ raw?: string }>).map((item) => item.raw).filter(Boolean).join('; '),
      jobUrl: row.job.canonicalUrl,
      jobDescription: row.job.descriptionText,
      externalJobId: source?.sourceId,
      portalId: source?.portalId ?? row.candidate.sourcePortal,
      portalName: source?.portalId ?? row.candidate.sourcePortal,
      matchScore: row.candidate.score,
      status: 'queued',
      resumeVariantName: row.variant.fileName,
      huntRunId: row.candidate.runId,
    })
    .onConflictDoNothing()
    .returning()
  if (!application) {
    ;[application] = await db
      .select()
      .from(applications)
      .where(and(eq(applications.userId, userId), eq(applications.jobId, row.job.id)))
      .limit(1)
  }
  if (!application) throw new Error('Could not create application record')
  if (application.status === 'applied' || application.status === 'viewed' || application.status === 'interview') {
    await db.update(huntCandidates).set({ status: 'applied', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
    return
  }

  const [attempt] = await db
    .insert(applyAttempts)
    .values({
      candidateId,
      userId,
      portalId: source?.portalId ?? row.candidate.sourcePortal,
      status: 'submitting',
      startedAt: new Date(),
    })
    .returning()
  if (!attempt) throw new Error('Could not create application intent')
  fenceAttemptId = attempt.id

  await db.update(huntCandidates).set({ status: 'applying', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
  await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'applying')
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'huntly-apply-'))
  const dryRun = options?.dryRun ?? env.APPLY_DRY_RUN

  // What this project knows about the site being applied to: where it may
  // navigate, whether it needs a signed-in profile, whether it is worth paying
  // for a residential exit. Null is fine and common — most ATS forms are
  // generic and need none of it.
  const skill = skillForUrl(applyUrl)
  let profileId = skill?.manifest.authMode === 'profile' ? await profileFor(userId, skill.manifest.id) : null
  if (browserProvider === 'vm' && !profileId) {
    const [session] = await db.select({ vmId: userBrowserSessions.vmId, tenantIndex: userBrowserSessions.tenantIndex })
      .from(userBrowserSessions)
      .where(eq(userBrowserSessions.userId, userId))
      .limit(1)
    if (!session) throw badRequest('Connect your browser session before preparing an application.')
    profileId = `vm:${session.vmId}:${session.tenantIndex}`
  }

  let session: Awaited<ReturnType<typeof openSession>> | null = null
  // Declared out here so the `finally` can stop it however the attempt ends.
  let screencast: Awaited<ReturnType<typeof startScreencast>> | null = null

  try {
    session = await openSession({
      userId,
      label: `apply:${skill?.manifest.id ?? 'generic'}`,
      profileId,
      proxyCountry: skill?.manifest.proxyCountry ?? null,
    })
    options?.signal?.throwIfAborted()
    options?.signal?.addEventListener('abort', () => { void session?.close().catch(error => logger.error({ err: error }, 'could not close browser after application lease loss')) }, { once: true })
    await transition({ attemptId: attempt.id, userId, state: 'opening', detail: { applyUrl, dryRun } })

    const resumePath = path.join(scratch, path.basename(row.variant.fileName))
    const resumeBytes = await downloadObject(row.variant.storagePath)
    await writeFile(resumePath, resumeBytes)
    const page = session.page
    try {
      await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    } catch (error) {
      // A transient navigation issue should reach the model-assisted tier so
      // it can inspect the page and choose a recovery path. Only repeated
      // failures in that bounded tier become an error/review outcome.
      logger.warn({ err: error, applyUrl, attemptId: attempt.id }, 'initial application navigation failed')
    }

    // A hosted session publishes its own live URL, which is a real browser the
    // user can click in rather than a stream of frames they can only watch.
    // Frame streaming stays for the local provider, and only while somebody is
    // actually watching — an unwatched application should cost nothing extra.
    if (session.liveUrl || session.sessionId) {
      await db
        .update(applyAttempts)
        .set({ liveUrl: session.liveUrl, browserSessionId: session.sessionId, updatedAt: new Date() })
        .where(eq(applyAttempts.id, attempt.id))
    }
    screencast = await startScreencast({ page, userId, attemptId: attempt.id })

    if (await page.locator('input[type="password"]:visible, input[autocomplete="one-time-code"]:visible').count() > 0) {
      await transition({attemptId:attempt.id,userId,state:'blocked',reason:'login_required'})
      await db.update(applyAttempts).set({status:'needs_review',error:'Provider requires human sign-in or verification. Reconnect your browser session.',completedAt:new Date(),updatedAt:new Date()}).where(eq(applyAttempts.id,attempt.id))
      await db.update(huntCandidates).set({status:'needs_review',updatedAt:new Date()}).where(eq(huntCandidates.id,candidateId))
      await db.update(applications).set({status:'needs_review',notes:'Provider requires human sign-in or verification. Reconnect your browser session.',updatedAt:new Date()}).where(eq(applications.id,application.id))
      await setRunJobStatus(row.candidate.runId,row.candidate.jobId,'needs_review')
      return
    }

    // Where the candidate is and where the job is. Work-authorisation questions
    // are derived from the pair rather than asked on every posting — see
    // `work-authorisation.ts`.
    const authorisation = {
      candidateCountry: countryCodeFor(profile.address.country),
      jobCountries: (row.job.locations as Array<{ countryCode?: string | null }>)
        .map((place) => place.countryCode)
        .filter((code): code is string => Boolean(code)),
      remote: row.job.remoteMode === 'remote',
    }

    await transition({ attemptId: attempt.id, userId, state: 'filling' })
    const result = await fillForm({
      page,
      url: applyUrl,
      userId,
      attemptId: attempt.id,
      profile,
      resumePath,
      authorisation,
    })

    let audit = result.fields.map((field) => ({
      label: field.label,
      kind: field.via,
      value: field.filled ? '[provided]' : '[blank]',
    }))
    let unresolved = result.unresolved
    let agentSubmitted = false
    let agentElapsedMs=0
    let agentCanSubmit=!hasReasoningDriver
    for(let round=0;round<(useOpenClaw?1:hasApplyAgent?3:1);round++){
      options?.signal?.throwIfAborted()
      if(submissionWasAttempted()||agentElapsedMs>=600_000)break
      unresolved=await waitForApplicationAnswers({page,userId,applicationId:application.id,attemptId:attempt.id,unresolved,
        optionalLabels:result.fields.filter(field=>!field.filled&&field.via==='skipped').map(field=>field.label),signal:options?.signal,waitForHuman:false})
      const providedRows=await db.select().from(pendingApplicationQuestions).where(and(eq(pendingApplicationQuestions.userId,userId),eq(pendingApplicationQuestions.attemptId,attempt.id),eq(pendingApplicationQuestions.status,'applied')))
      const providedAnswers:ProvidedFormAnswer[]=providedRows.filter(q=>q.answer!==null&&!forbiddenQuestion({label:q.label,type:q.type,name:q.fieldName??undefined})).map(q=>({label:q.label,name:q.fieldName??undefined,type:q.type,host:q.host,value:q.answer!,source:q.answerMeta.source==='profile_ai'?'profile_ai':'user'}))

    // The reasoning driver reviews the remainder after cheap profile filling and semantic answer
    // resolution. Missing facts are questions, never a reason to skip reasoning.
    const agentRoundStarted=Date.now()
    if (hasReasoningDriver) {
      await transition({
        attemptId: attempt.id,
        userId,
        state: 'filling',
        detail: {
          tier: useOpenClaw ? 'openclaw' : 'agent',
          reason:
            result.fields.length === 0
              ? 'no_form_found'
              : unresolved.length > 0
                ? 'unresolved_fields'
                : 'no_submit_control',
        },
      })
      try {
        // A site skill knows things the generic path cannot: that Work at a
        // Startup's application *is* a message to the founders, for instance.
        // Without one, the generic agent runs on the same session.
        const legacy = async () => applyWithAgent({
          session:session!,userId,applyUrl,dryRun:useOpenClaw?true:dryRun,profile,resumePath,
          job:{title:row.job.title,company:row.job.company},providedAnswers,
          resumeCurrentPage:true,playbook:skill?await skill.playbook():undefined,
          maxSteps:Math.min(env.APPLY_AGENT_MAX_STEPS,18),maxDurationMs:Math.max(1,600_000-agentElapsedMs-(Date.now()-agentRoundStarted)),
        })
        let agent: Awaited<ReturnType<typeof applyWithAgent>>
        if (useOpenClaw) {
          if (session.provider !== 'vm' || !profileId) throw new OpenClawApplyError('OpenClaw requires an owned VM browser profile.', false)
          const tenantIndex = parseVmProfile(profileId, env.VM_ID)
          const stagedResume = await uploadTenantResume(tenantIndex, Buffer.from(resumeBytes))
          const dossier = await loadOpenClawDossier(userId, attempt.id, [host, new URL(page.url()).hostname])
          const guardSession=await page.context().newCDPSession(page)
          const targetInfo=await guardSession.send('Target.getTargetInfo')
          await guardSession.detach()
          const targetId=targetInfo.targetInfo.targetId
          const approvalCandidates=[...providedAnswers.filter(field=>field.source==='user').map(field=>({label:field.label,type:field.type,value:field.value})),...dossier.answers.filter(answer=>answer.source==='explicit_user'&&['reusable','this_attempt'].includes(answer.scope)).map(answer=>({label:answer.label,type:answer.type,value:answer.value}))]
          const approvedFields=[...new Map(approvalCandidates.map(field=>[JSON.stringify([field.label.trim().replace(/\s+/g,' ').toLowerCase(),field.type]),field])).values()]
          const policy=await installOpenClawPolicy(tenantIndex,{attemptId:attempt.id,targetId,deadlineEpoch:Date.now()+env.OPENCLAW_RUN_TIMEOUT_MS,allowedHosts:[...new Set([host,new URL(page.url()).hostname])],approvedFields:approvedFields.slice(0,200),resumePath:stagedResume.path})
          try {
            agent = await applyWithOpenClaw({
              tenantIndex: tenantIndex, targetId, attemptId: attempt.id, applyUrl, currentUrl: page.url(), resumePath: policy.resumePath??stagedResume.path, profile, dossier,
              job: { title: row.job.title, company: row.job.company, countries: authorisation.jobCountries, description: row.job.descriptionText ?? undefined },
              unresolved, timeoutMs: env.OPENCLAW_RUN_TIMEOUT_MS, signal: options?.signal,
              onLifecycle: async event => {
                if (event.state === 'step') {
                  publishAttemptEvent(userId, { type: 'state', attemptId: attempt.id, state: 'filling', reason: null,
                    detail: { tier: 'openclaw', runId: event.runId, stage: 'reasoning' }, at: new Date().toISOString() })
                  return
                }
                await transition({ attemptId: attempt.id, userId, state: 'filling',
                  detail: { tier: 'openclaw', runId: event.runId, tenantIndex: tenantIndex, lifecycle: event.state, ...event.detail } })
              },
            })
          } catch (error) {
            if (error instanceof OpenClawApplyError && error.possibleSubmission) await noteUnexpectedSubmission()
            options?.signal?.throwIfAborted()
            if (!(error instanceof OpenClawApplyError) || !error.safeToFallback || !hasApplyAgent) throw error
            await transition({ attemptId: attempt.id, userId, state: 'filling', detail: { tier: 'legacy_fallback', reason: 'openclaw_stopped' } })
            // Kept until three postings across two ATS families pass. This
            // driver also stops before submit; only submitForm below clicks it.
            await revokeOpenClawPolicy(tenantIndex,attempt.id)
            agent = await legacy()
          } finally { await revokeOpenClawPolicy(tenantIndex,attempt.id).catch(()=>undefined) }
        } else agent = await legacy()
        if (useOpenClaw) {
          agent.filled = await verifyOpenClawFilledFields(page, agent.filled)
          const verifiedLabels=agent.filled.map(field=>field.label)
          if(verifiedLabels.length)await db.update(pendingApplicationQuestions).set({status:'applied',blockedReason:null,updatedAt:new Date()}).where(and(eq(pendingApplicationQuestions.userId,userId),eq(pendingApplicationQuestions.attemptId,attempt.id),inArray(pendingApplicationQuestions.label,verifiedLabels),inArray(pendingApplicationQuestions.status,['answered','failed'])))
        }
        agentCanSubmit=agent.canSubmit===true
        logger.info(
          { attemptId: attempt.id, skill: skill?.manifest.id ?? null, reached: agent.reached, filled: agent.filled.length, blocked: agent.blocked.length },
          'agent tier finished',
        )
        if (agent.reached === 'submitted') {
          if (!submissionWasAttempted()) await beforeSubmission()
          agentSubmitted = await hasSubmissionConfirmation(page,applyUrl)
          if (!agentSubmitted) throw new Error('Agent reported a submit, but provider confirmation was not observed.')
        }
        submissionConfirmed = agentSubmitted
        if (agent.reached !== 'nothing') {
          audit = [
            ...audit,
            ...agent.filled.map((field) => ({
              label: field.label,
              kind: 'agent' as const,
              value: '[provided]',
            })),
          ]

          // The agent's self-report can add blockers but not wish them away.
          //
          // Replacing the list outright is what the first version did, and on
          // a real Anthropic form it turned seven genuinely unanswered
          // required questions — including "Why Anthropic?" — into a clean
          // record with zero blockers, because the agent said it had reached
          // the form and listed nothing as blocked. An application that is
          // silently recorded as complete when it is not is worse than one
          // correctly parked for review, so a blocker the ladder *measured*
          // clears only when the agent names that exact field as filled.
          const agentFilled = new Set(agent.filled.map((field) => normaliseLabel(field.label)))
          const stillBlocked = unresolved.filter(
            (field) => !agentFilled.has(normaliseLabel(field.label)),
          )
          const known = new Set(stillBlocked.map((field) => normaliseLabel(field.label)))
          unresolved = [
            ...stillBlocked,
            ...agent.blocked
              .filter((field) => !known.has(normaliseLabel(field.label))&&!providedAnswers.some(answer=>normaliseLabel(answer.label)===normaliseLabel(field.label)))
              .map((field) => ({ label: field.label, type: 'text', why: field.why as never })),
          ]
          if (agentSubmitted) unresolved = []
        }
      } catch (error) {
        // A failed agent must not lose the deterministic tier's work — the
        // attempt falls through to review with whatever the ladder managed.
        if (error instanceof ModelServiceUnavailableError || submissionWasAttempted() || error instanceof OpenClawApplyError && !error.safeToFallback) throw error
        logger.warn({ err: error, attemptId: attempt.id }, 'agent tier failed; keeping ladder result')
      }
    }

    agentElapsedMs+=Date.now()-agentRoundStarted
    if(submissionWasAttempted()&&!agentSubmitted)throw new Error('Submission was attempted without confirmed completion; refusing another browser reasoning round.')
    const needsPostAnswerReview=unresolved.length>0
    if (!submissionWasAttempted()) {
      // Resolve, do not wait. Parking here held every application for ten
      // minutes on questions the owner had already answered elsewhere — and,
      // in the run that prompted this, on two *optional* checkboxes. Anything
      // still unresolved goes to the agent tier, which can reason about the
      // page; a question nobody can answer ends the attempt honestly rather
      // than holding a browser open for a human who is not there.
      unresolved = await waitForApplicationAnswers({page,userId,applicationId:application.id,attemptId:attempt.id,unresolved,
        optionalLabels:result.fields.filter(field=>!field.filled&&field.via==='skipped').map(field=>field.label),signal:options?.signal,
        waitForHuman:env.APPLY_WAIT_FOR_HUMAN})
    }

      if(agentSubmitted||unresolved.length>0)break
      if(needsPostAnswerReview&&hasReasoningDriver){agentCanSubmit=false;continue}
      if(!hasReasoningDriver||agentCanSubmit)break
    }
    if(hasReasoningDriver&&!agentSubmitted&&!agentCanSubmit&&unresolved.length===0){
      unresolved=[{label:'The browser agent could not complete this page within its bounded reasoning budget. No final submission was attempted.',type:'automation',why:'automation_limit'}]
    }

    if (unresolved.length > 0) {
      const evidenceStoragePath = await persistEvidence(userId, attempt.id, page)
      await transition({
        attemptId: attempt.id,
        userId,
        state: 'blocked',
        reason: unresolved[0]?.why ?? 'needs_input',
        detail: {
          fields: unresolved,
          recipe: result.recipe,
          takeoverWindowMs: env.APPLY_TAKEOVER_WINDOW_MS,
        },
      })

      // Hold the page open for a few minutes so the user can finish it in the
      // same browser. This is the difference between handing someone a broken
      // attempt afterwards and letting them rescue it while it is still live.
      if (session.provider !== 'vm' && await isWatched(attempt.id)) {
        const outcome = await awaitTakeover({
          page,
          attemptId: attempt.id,
          windowMs: env.APPLY_TAKEOVER_WINDOW_MS,
        })
        logger.info({ attemptId: attempt.id, outcome }, 'takeover window closed')
        if (outcome === 'released') {
          // They said they are done. Re-read the form and carry on from
          // wherever they left it, rather than starting over.
          const recheck = await fillForm({
            authorisation,
            page,
            url: applyUrl,
            userId,
            attemptId: attempt.id,
            profile,
            resumePath,
          })
          if (recheck.unresolved.length === 0) {
            await transition({ attemptId: attempt.id, userId, state: 'filling', detail: { dryRun, afterTakeover: true, stage:'validating_submission' } })
            const retried = await submitForm({ page, url: applyUrl, dryRun })
            submissionConfirmed = retried.submitted
            if (retried.submitted) {
              await transition({ attemptId: attempt.id, userId, state: 'submitted', detail: { afterTakeover: true } })
              await db.update(applyAttempts).set({
                status: 'submitted',
                evidenceStoragePath: await persistEvidence(userId, attempt.id, page),
                completedAt: new Date(),
                updatedAt: new Date(),
              }).where(eq(applyAttempts.id, attempt.id))
              await db.update(huntCandidates).set({ status: 'applied', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
              await db.update(applications).set({ status: 'applied', appliedAt: new Date(), updatedAt: new Date() }).where(eq(applications.id, application.id))
              await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'applied')
              return
            }
          }
        }
      }
      await db.update(applyAttempts).set({
        submittedFields: audit,
        unresolvedFields: unresolved,
        evidenceStoragePath,
        updatedAt: new Date(),
      }).where(eq(applyAttempts.id, attempt.id))
      await db.update(huntCandidates).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
      await db.update(applications).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(applications.id, application.id))
      await db.update(huntRuns).set({
        applicationsNeedsReview: sql`${huntRuns.applicationsNeedsReview} + 1`,
        updatedAt: new Date(),
      }).where(eq(huntRuns.id, row.candidate.runId))
      await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'needs_review')
      return
    }

    await transition({ attemptId: attempt.id, userId, state: 'filling', detail: { dryRun, stage:'validating_submission' } })
    const outcome = agentSubmitted
      ? { submitted: true as const }
      : await submitForm({ page, url: applyUrl, dryRun })
    submissionConfirmed = outcome.submitted
    const evidenceStoragePath = await persistEvidence(userId, attempt.id, page)

    if (!outcome.submitted) {
      // A dry run is a success, not a failure: the form was filled and the
      // screenshot proves it. Recording it as an error would make the safe
      // mode look broken and push people to turn it off.
      const heldBack = outcome.heldBack === 'dry_run' || outcome.heldBack === 'kill_switch'
      await transition({
        attemptId: attempt.id,
        userId,
        state: heldBack ? 'skipped' : 'blocked',
        ...(heldBack ? {} : { reason: 'needs_input' as const }),
        detail: { heldBack: outcome.heldBack ?? null, result: outcome.result ?? null, recipe: result.recipe },
      })
      // `pending` is the attempt's own starting state — reusing it here left a
      // completed dry run indistinguishable from one that had not started,
      // and downstream (applications, hunt_run_jobs, the run counters) never
      // heard the attempt had finished at all. `unknown` is the honest label:
      // filled correctly, outcome deliberately never determined.
      await db.update(applyAttempts).set({
        status: heldBack || outcome.result === 'submitted_unconfirmed' ? 'unknown' : 'needs_review',
        error: outcome.result === 'submitted_unconfirmed' ? 'Submit was clicked, but confirmation was not observed. Check the provider; do not retry automatically.' : outcome.heldBack ? `Not submitted: ${outcome.heldBack}` : null,
        submittedFields: audit,
        unresolvedFields: heldBack ? [] : [{ label: 'Submit control', type: 'button' }],
        evidenceStoragePath,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(applyAttempts.id, attempt.id))
      await db.update(huntCandidates).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
      await db.update(applications).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(applications.id, application.id))
      await db.update(huntRuns).set({
        applicationsNeedsReview: sql`${huntRuns.applicationsNeedsReview} + 1`,
        updatedAt: new Date(),
      }).where(eq(huntRuns.id, row.candidate.runId))
      await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'needs_review')
      logger.info(
        { attemptId: attempt.id, heldBack: outcome.heldBack, fields: audit.length },
        heldBack ? 'application filled but not submitted' : 'application could not be submitted',
      )
      return
    }

    await transition({ attemptId: attempt.id, userId, state: 'submitted', detail: { recipe: result.recipe } })
    await db.update(applyAttempts).set({
      status: 'submitted',
      submittedFields: audit,
      unresolvedFields: [],
      evidenceStoragePath,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(applyAttempts.id, attempt.id))
    await db.update(huntCandidates).set({ status: 'applied', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
    await db.update(applications).set({ status: 'applied', appliedAt: new Date(), updatedAt: new Date() }).where(eq(applications.id, application.id))
    await db.update(huntRuns).set({
      applicationsSubmitted: sql`${huntRuns.applicationsSubmitted} + 1`,
      updatedAt: new Date(),
    }).where(eq(huntRuns.id, row.candidate.runId))
    await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'applied')
  } catch (error) {
    if (submissionWasAttempted() || submissionConfirmed) {
      // A browser-side action cannot be rolled back. Failure to save a screenshot
      // or event must never turn a submitted/uncertain attempt into retryable failure.
      await db.update(applyAttempts).set({status:submissionConfirmed?'submitted':'unknown',error:submissionConfirmed?'Submitted; some evidence could not be saved.':'A submit may have reached the provider. Check the provider before taking further action.',completedAt:new Date(),updatedAt:new Date()}).where(eq(applyAttempts.id,attempt.id))
      await db.update(huntCandidates).set({status:submissionConfirmed?'applied':'needs_review',updatedAt:new Date()}).where(eq(huntCandidates.id,candidateId))
      await db.update(applications).set({status:submissionConfirmed?'applied':'needs_review',...(submissionConfirmed?{appliedAt:new Date()}:{}),updatedAt:new Date()}).where(eq(applications.id,application.id))
      await setRunJobStatus(row.candidate.runId,row.candidate.jobId,submissionConfirmed?'applied':'needs_review')
      logger.error({err:error,attemptId:attempt.id,submissionConfirmed},'application stopped after irreversible submission intent; never retry automatically')
      return
    }
    if (!session && error instanceof ApiError && error.status === 409) {
      await db.update(applyAttempts).set({status:'failed',error:'Browser is busy; deferred before opening application.',completedAt:new Date(),updatedAt:new Date()}).where(eq(applyAttempts.id,attempt.id))
      await db.update(huntCandidates).set({status:'queued',updatedAt:new Date()}).where(eq(huntCandidates.id,candidateId))
      await setRunJobStatus(row.candidate.runId,row.candidate.jobId,'queued')
      throw new ApplicationDeferredError()
    }
    await transition({
      attemptId: attempt.id,
      userId,
      state: 'failed',
      detail: { message: error instanceof Error ? error.message : String(error) },
    })
    await db.update(applyAttempts).set({
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date(),
    }).where(eq(applyAttempts.id, attempt.id))
    await db.update(huntCandidates).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
    await db.update(applications).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(applications.id, application.id))
    await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'needs_review')
    throw error
  } finally {
    await screencast?.stop().catch(() => undefined)
    // Closing the session also stops the hosted browser. Skipping that would
    // leave it billing until its own timeout expires.
    try { await session?.close() } finally { await rm(scratch, { recursive: true, force: true }) }
  }
  }, async () => {
    options?.signal?.throwIfAborted()
    if (!fenceAttemptId) throw new Error('Application intent is missing; refusing submission.')
    const [flag] = await db.select({id:attemptFlags.id}).from(attemptFlags).where(and(eq(attemptFlags.userId,userId),eq(attemptFlags.status,'open'))).limit(1)
    if (flag) throw new Error('Application flagged for review. Stopped before final submission.')
    const [intent] = await db.update(applyAttempts).set({submitStartedAt:new Date(),status:'submitting',updatedAt:new Date()}).where(and(eq(applyAttempts.id,fenceAttemptId),eq(applyAttempts.userId,userId))).returning({id:applyAttempts.id})
    if (!intent) throw new Error('Application intent disappeared; refusing submission.')
    void db.insert(attemptEvents).values({attemptId:fenceAttemptId,state:'submitting',detail:{dryRun:false}}).catch(()=>undefined)
    publishAttemptEvent(userId,{type:'state',attemptId:fenceAttemptId,state:'submitting',reason:null,detail:{dryRun:false},at:new Date().toISOString()})
  })
}
