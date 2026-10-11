import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import type { Page } from 'playwright-core'
import { db } from '../../db/client.js'
import { applications, applyAttempts, attemptEvents, attemptFlags, huntCandidates, huntRuns, jobSources, jobs, resumeVariants, userBrowserSessions } from '../../db/schema.js'
import { env } from '../../config/env.js'
import { badRequest, notFound } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import { buildObjectKey, downloadObject, uploadObject } from '../../lib/storage.js'
import { openSession, type AgentSession } from '../../browser/session.js'
import { VmAgentBusyError } from '../../browser/vm-client.js'
import { loadPortalProfile } from '../portal-profile.js'
import { provisionPortalAccount } from '../portal-accounts.js'
import { createMinimalResumeVariant } from '../tailoring.js'
import { ApplicationDeferredError } from '../application-policy.js'
import { createAttempt, finishAttempt, previousTransientRetries, recordSubmitOutcome, type AttemptContext } from './attempt-store.js'
import { classifyError, shouldAutoRetry, type FailureClass } from './failure.js'
import { submitForm, type SubmitResult } from './fill.js'
import { fillVerificationCode } from './gmail-code.js'
import { withProfileLane } from './lanes.js'
import { executePlannedApplication, preparePlannedApplication, type PlannedExecution } from './planned/driver.js'
import { jobContext } from './planned/dossier.js'
import { recordPlanQuestions } from './planned/plan-questions.js'
import { storablePlan, type AnswerPlan } from './planned/planner.js'
import { PROVIDER_SPAM_MESSAGE } from './provider-block.js'
import { publishAttemptEvent } from './events.js'
import { startScreencast } from './screencast.js'
import { transition } from './state.js'
import { submissionMayHaveReachedProvider, withSubmissionGuard } from './submission-guard.js'
import { openApplicationPage, requiresSignedInProfile, resolveApplicationTarget } from './target.js'
import { readVerificationCode } from './verification-code.js'
import { countryCodeFor } from './work-authorisation.js'

/**
 * One approved candidate, applied with the planned driver.
 *
 *   plan (no browser) ─► ask the user first if a required answer is missing
 *   browser            ─► throwaway context, or the signed-in profile for account portals
 *   fill + verify      ─► gate ─► fenced submit ─► classified outcome
 *   repair             ─► a provably rejected click is repaired and retried twice
 *   code               ─► an emailed verification code is read and entered
 *   failure            ─► classified; transient pre-submit failures re-queue themselves
 */

/** In-process plan cache: a deferred or retried attempt does not pay for planning twice. */
const planCache = new Map<string, { plan: AnswerPlan; at: number }>()
const PLAN_TTL_MS = 6 * 60 * 60_000

async function earlierPlan(candidateId: string): Promise<AnswerPlan | null> {
  const cached = planCache.get(candidateId)
  if (cached && Date.now() - cached.at < PLAN_TTL_MS) return cached.plan
  const [row] = await db.select({ plan: applyAttempts.answerPlan, at: applyAttempts.createdAt }).from(applyAttempts)
    .where(and(eq(applyAttempts.candidateId, candidateId), isNotNull(applyAttempts.answerPlan))).orderBy(desc(applyAttempts.createdAt)).limit(1)
  if (!row?.plan || Date.now() - row.at.getTime() > PLAN_TTL_MS) return null
  return row.plan as AnswerPlan
}

async function persistEvidence(userId: string, attemptId: string, page: Page | null | undefined): Promise<string | null> {
  if (!page || page.isClosed()) return null
  try {
    const screenshot = await page.screenshot({ fullPage: true, type: 'png', timeout: 15_000 })
    const key = buildObjectKey(userId, 'application-evidence', `${attemptId}.png`)
    await uploadObject({ key, body: Buffer.from(screenshot), mimeType: 'image/png' })
    return key
  } catch (error) {
    // Evidence is useful, never decisive: its failure must not change the outcome.
    logger.warn({ err: error, attemptId }, 'could not save application evidence')
    return null
  }
}

function classifyBlockers(execution: PlannedExecution): FailureClass {
  const reasons = new Set(execution.blockers.map((blocker) => blocker.reason))
  if ([...reasons].every((reason) => reason === 'needs_answer')) return 'needs_answer'
  const filled = execution.results.filter((row) => row.status === 'filled').length
  if (reasons.has('no_submit_control') && filled === 0) return 'unsupported'
  if (reasons.has('unfilled_required') && execution.plan.answers.some((row) => row.required && row.action === 'ask')) return 'needs_answer'
  return 'automation'
}

export async function applyPlannedCandidate(userId: string, candidateId: string, options?: { dryRun?: boolean; signal?: AbortSignal; holdsProfileLane?: boolean }): Promise<void> {
  options?.signal?.throwIfAborted()
  const [candidateState] = await db.select({ resumeVariantId: huntCandidates.resumeVariantId, runId: huntCandidates.runId })
    .from(huntCandidates).where(and(eq(huntCandidates.id, candidateId), eq(huntCandidates.userId, userId))).limit(1)
  if (!candidateState) throw notFound('Approved candidate not found')
  const [run] = await db.select({ status: huntRuns.status }).from(huntRuns).where(eq(huntRuns.id, candidateState.runId)).limit(1)
  if (!run || run.status === 'stopped' || run.status === 'failed') return
  if (!candidateState.resumeVariantId) await createMinimalResumeVariant(userId, candidateId)
  const [row] = await db.select({ candidate: huntCandidates, job: jobs, variant: resumeVariants })
    .from(huntCandidates).innerJoin(jobs, eq(huntCandidates.jobId, jobs.id)).innerJoin(resumeVariants, eq(huntCandidates.resumeVariantId, resumeVariants.id))
    .where(and(eq(huntCandidates.id, candidateId), eq(huntCandidates.userId, userId))).limit(1)
  if (!row) throw notFound('Approved candidate or resume variant not found')
  if (!['tailored', 'queued', 'applying'].includes(row.candidate.status)) throw badRequest('Candidate is not approved for application.')

  const [source] = await db.select().from(jobSources).where(and(eq(jobSources.jobId, row.job.id), eq(jobSources.portalId, row.candidate.sourcePortal))).limit(1)
  const target = resolveApplicationTarget(row.job, source)
  if (!target) throw badRequest('This job has no usable application URL.')
  const portal = source?.portalId ?? row.candidate.sourcePortal

  const [application] = await db.insert(applications).values({
    userId, jobId: row.job.id, role: row.job.title, company: row.job.company,
    location: (row.job.locations as Array<{ raw?: string }>).map((item) => item.raw).filter(Boolean).join('; '),
    jobUrl: row.job.canonicalUrl, jobDescription: row.job.descriptionText, externalJobId: source?.sourceId,
    portalId: portal, portalName: portal, matchScore: row.candidate.score, status: 'queued', resumeVariantName: row.variant.fileName, huntRunId: row.candidate.runId,
  }).onConflictDoNothing().returning().then(async (inserted) => inserted.length ? inserted : db.select().from(applications).where(and(eq(applications.userId, userId), eq(applications.jobId, row.job.id))).limit(1))
  if (!application) throw new Error('Could not create application record')
  if (['applied', 'viewed', 'interview'].includes(application.status)) {
    await db.update(huntCandidates).set({ status: 'applied', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
    return
  }

  const retryIndex = await previousTransientRetries(candidateId)
  const attempt = await createAttempt({ candidateId, userId, portalId: portal, retryIndex })
  const context: AttemptContext = { attemptId: attempt.id, userId, candidateId, applicationId: application.id, runId: row.candidate.runId, jobId: row.job.id, portal, retryIndex }
  await db.update(huntCandidates).set({ status: 'applying', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
  const dryRun = options?.dryRun ?? env.APPLY_DRY_RUN
  const lostBrowser = new AbortController()
  const signal = options?.signal ? AbortSignal.any([options.signal, lostBrowser.signal]) : lostBrowser.signal
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'huntly-apply-'))
  let session: AgentSession | null = null
  let screencast: Awaited<ReturnType<typeof startScreencast>> | null = null
  let plan: AnswerPlan | null = null
  let schemaSource: string | null = null
  let audit: unknown = undefined

  await withSubmissionGuard(async () => {
    try {
      // Account portals need a verified provider account before anything else.
      if (/wellfound\.com|instahyre\.com/i.test(target.host)) {
        const account = await provisionPortalAccount(userId, target.host.includes('wellfound') ? 'wellfound' : 'instahyre')
        if (account.status !== 'ready') {
          await finishAttempt(context, { outcome: 'needs_review', failureClass: 'unsupported', error: account.actionRequired ?? 'Connect and verify the provider account.', unresolvedFields: [{ label: account.actionRequired ?? 'Complete portal account verification', type: 'account', why: 'login_required' }] })
          return
        }
      }

      const profile = await loadPortalProfile(userId)
      const locations = row.job.locations as Array<{ raw?: string; countryCode?: string | null }>
      const job = jobContext({
        title: row.job.title,
        company: row.job.company,
        location: application.location || locations.map((place) => place.raw).filter(Boolean).join('; ') || null,
        countries: locations.map((place) => place.countryCode ?? '').filter(Boolean),
        remote: row.job.remoteMode === 'remote',
        description: row.job.descriptionText,
      })
      if (!job.countries.length && row.job.remoteMode !== 'remote') {
        const named = countryCodeFor(job.location)
        if (named) job.countries.push(named)
      }

      await transition({ attemptId: attempt.id, userId, state: 'resolving_answers', detail: { applyUrl: target.applyUrl, dryRun, driver: 'planned' } })
      const prepared = await preparePlannedApplication({ userId, applicationId: application.id, urls: target.urls, profile, job, reuse: await earlierPlan(candidateId), signal })
      plan = prepared.plan
      schemaSource = prepared.schema?.source ?? null
      if (plan) planCache.set(candidateId, { plan, at: Date.now() })
      if (prepared.closed) {
        await transition({ attemptId: attempt.id, userId, state: 'blocked', reason: 'posting_closed' })
        await finishAttempt(context, { outcome: 'closed', failureClass: 'posting_closed', error: 'Not submitted: posting_closed', schemaSource })
        return
      }
      if (prepared.missing.length && prepared.schema && prepared.plan) {
        // Ask before opening a browser: a form we cannot complete is not started.
        const recorded = await recordPlanQuestions({ userId, applicationId: application.id, attemptId: attempt.id, host: target.host, fields: prepared.schema.fields, answers: prepared.plan.answers })
        await transition({ attemptId: attempt.id, userId, state: 'blocked', reason: 'needs_input', detail: { questions: recorded, fields: prepared.missing.map((row) => row.label).slice(0, 20) } })
        await finishAttempt(context, {
          outcome: 'needs_review', failureClass: 'needs_answer',
          unresolvedFields: prepared.missing.map((row) => ({ label: row.label, type: row.kind, why: 'needs_input', reason: row.reason })),
          answerPlan: storablePlan(prepared.plan), schemaSource,
        })
        return
      }

      // Only account portals need the signed-in profile; everything else gets a throwaway context.
      const needsProfile = requiresSignedInProfile(target.urls)
      let profileId: string | null = null
      if (needsProfile) {
        const [vm] = await db.select({ vmId: userBrowserSessions.vmId, tenantIndex: userBrowserSessions.tenantIndex }).from(userBrowserSessions).where(eq(userBrowserSessions.userId, userId)).limit(1)
        if (!vm) {
          await finishAttempt(context, { outcome: 'needs_review', failureClass: 'unsupported', error: 'This portal needs your signed-in browser. Connect your browser session first.' })
          return
        }
        profileId = `vm:${vm.vmId}:${vm.tenantIndex}`
      }
      try {
        session = await openSession({
          userId,
          label: `apply:planned:${needsProfile ? 'profile' : 'ephemeral'}`,
          profileId,
          ephemeral: !needsProfile,
          reclaimStaleApply: needsProfile && options?.holdsProfileLane === true,
          onBrowserLost: (reason) => lostBrowser.abort(new Error(`Browser closed mid-application: ${reason}`)),
        })
      } catch (error) {
        if (error instanceof VmAgentBusyError) {
          // The user is signing in on that profile. Nothing ran: forget this attempt and try later.
          await db.delete(attemptEvents).where(eq(attemptEvents.attemptId, attempt.id))
          await db.delete(applyAttempts).where(eq(applyAttempts.id, attempt.id))
          await db.update(huntCandidates).set({ status: 'queued', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
          throw new ApplicationDeferredError('Your signed-in browser is in use; this application will start when it is free.')
        }
        throw error
      }
      signal.throwIfAborted()
      const browserSession = session
      await db.update(applyAttempts).set({ browserSessionId: browserSession.sessionId, liveUrl: browserSession.liveUrl, updatedAt: new Date() }).where(eq(applyAttempts.id, attempt.id))
      await transition({ attemptId: attempt.id, userId, state: 'opening', detail: { applyUrl: target.applyUrl, browser: browserSession.provider } })

      const resumePath = path.join(scratch, path.basename(row.variant.fileName))
      await writeFile(resumePath, await downloadObject(row.variant.storagePath))
      const page = browserSession.page
      const formUrl = await openApplicationPage(page, target, attempt.id)
      screencast = await startScreencast({ page, userId, attemptId: attempt.id }).catch(() => null)

      if (await page.locator('input[type="password"]:visible, input[autocomplete="one-time-code"]:visible').count().catch(() => 0) > 0) {
        await transition({ attemptId: attempt.id, userId, state: 'blocked', reason: 'login_required' })
        await finishAttempt(context, { outcome: 'needs_review', failureClass: 'unsupported', error: 'This employer requires signing in to apply.', evidenceStoragePath: await persistEvidence(userId, attempt.id, page), schemaSource })
        return
      }

      await transition({ attemptId: attempt.id, userId, state: 'filling', detail: { driver: 'planned', schema: schemaSource ?? 'dom' } })
      let execution = await executePlannedApplication({ page, prepared, userId, applicationId: application.id, attemptId: attempt.id, resumePath, signal })
      plan = execution.plan
      schemaSource = execution.schema.source
      audit = execution.fields
      if (!execution.canSubmit) {
        await recordPlanQuestions({ userId, applicationId: application.id, attemptId: attempt.id, host: new URL(formUrl).hostname, fields: execution.schema.fields, answers: execution.plan.answers }).catch(() => 0)
        const failureClass = classifyBlockers(execution)
        await transition({ attemptId: attempt.id, userId, state: 'blocked', reason: execution.unresolved[0]?.why ?? 'needs_input', detail: { blockers: execution.blockers.slice(0, 20) } })
        await finishAttempt(context, { outcome: 'needs_review', failureClass, submittedFields: execution.fields, unresolvedFields: execution.unresolved, evidenceStoragePath: await persistEvidence(userId, attempt.id, page), answerPlan: storablePlan(execution.plan), schemaSource })
        return
      }

      await transition({ attemptId: attempt.id, userId, state: 'filling', detail: { stage: 'validating_submission', dryRun } })
      const clickAt = Date.now()
      let outcome: SubmitResult = await submitForm({ page, url: formUrl, dryRun, skipWidgetReady: true })
      // Provably rejected: repair what the page complains about and click again.
      for (let repair = 0; repair < 2 && outcome.outcome === 'rejected_validation'; repair += 1) {
        logger.info({ attemptId: attempt.id, repair, errors: outcome.errors }, 'submit rejected by validation; repairing and retrying')
        execution = await executePlannedApplication({ page, prepared: { ...prepared, plan: execution.plan, schema: execution.schema }, userId, applicationId: application.id, attemptId: attempt.id, resumePath, signal })
        audit = execution.fields
        if (!execution.canSubmit) break
        outcome = await submitForm({ page, url: formUrl, dryRun, skipWidgetReady: true })
      }
      const usedCodes = new Set<string>()
      for (let round = 0; round < 2 && outcome.outcome === 'verification_required'; round += 1) {
        await transition({ attemptId: attempt.id, userId, state: 'filling', detail: { stage: 'verification_code' } })
        const code = await readVerificationCode({
          userId, page, sinceMs: clickAt - 5_000, skip: usedCodes, signal,
          pageHasMailbox: browserSession.provider === 'vm',
          borrowProfile: browserSession.provider === 'vm' ? null : (work) => withProfileLane(userId, work, 45_000),
        })
        if (!code) break
        usedCodes.add(code)
        if (!await fillVerificationCode(page, code)) break
        outcome = await submitForm({ page, url: formUrl, dryRun, skipWidgetReady: true })
      }

      const evidence = await persistEvidence(userId, attempt.id, page)
      if (outcome.submitted) {
        await transition({ attemptId: attempt.id, userId, state: 'submitted', detail: { reason: outcome.reason } })
        await finishAttempt(context, { outcome: 'submitted', submitOutcome: 'confirmed', submittedFields: execution.fields, unresolvedFields: [], evidenceStoragePath: evidence, answerPlan: storablePlan(execution.plan), schemaSource })
        return
      }
      if (outcome.heldBack === 'dry_run' || outcome.heldBack === 'kill_switch') {
        await transition({ attemptId: attempt.id, userId, state: 'skipped', detail: { heldBack: outcome.heldBack } })
        await finishAttempt(context, { outcome: 'unknown', error: `Not submitted: ${outcome.heldBack}`, note: outcome.heldBack === 'dry_run' ? 'Dry run: the form was completed and verified, then left unsubmitted.' : 'Submissions are paused by the kill switch.', submittedFields: execution.fields, unresolvedFields: [], evidenceStoragePath: evidence, answerPlan: storablePlan(execution.plan), schemaSource })
        return
      }
      if (outcome.result === 'provider_blocked') {
        await transition({ attemptId: attempt.id, userId, state: 'blocked', reason: 'provider_blocked' })
        await finishAttempt(context, { outcome: 'needs_review', failureClass: 'provider_rejected', submitOutcome: 'provider_blocked', error: PROVIDER_SPAM_MESSAGE, submittedFields: execution.fields, evidenceStoragePath: evidence, answerPlan: storablePlan(execution.plan), schemaSource })
        return
      }
      if (outcome.outcome === 'uncertain') {
        await transition({ attemptId: attempt.id, userId, state: 'blocked', reason: 'needs_input', detail: { uncertain: outcome.reason } })
        await finishAttempt(context, { outcome: 'unknown', failureClass: 'uncertain_submit', submitOutcome: 'uncertain', error: `Submit was clicked but not confirmed (${outcome.reason ?? 'no signal'}). Waiting for the confirmation email; do not resubmit.`, submittedFields: execution.fields, evidenceStoragePath: evidence, answerPlan: storablePlan(execution.plan), schemaSource })
        return
      }
      const verification = outcome.outcome === 'verification_required'
      const failureClass: FailureClass = verification ? 'unsupported' : outcome.heldBack === 'posting_closed' ? 'posting_closed' : outcome.heldBack === 'no_form' || outcome.heldBack === 'no_submit_control' ? 'unsupported' : 'automation'
      await transition({ attemptId: attempt.id, userId, state: 'blocked', reason: verification ? 'verification_code' : outcome.heldBack === 'posting_closed' ? 'posting_closed' : 'field_rejected', detail: { errors: outcome.errors ?? [] } })
      await finishAttempt(context, {
        outcome: failureClass === 'posting_closed' ? 'closed' : 'needs_review',
        failureClass,
        ...(outcome.outcome ? { submitOutcome: outcome.outcome } : {}),
        error: verification ? 'The employer emailed a verification code that could not be read. Connect Gmail in Inbox so codes can be read automatically.' : `Not submitted: ${outcome.heldBack ?? 'invalid_fields'}${outcome.errors?.length ? ` (${outcome.errors.slice(0, 3).join('; ')})` : ''}`,
        submittedFields: execution.fields,
        unresolvedFields: (outcome.errors ?? []).map((label) => ({ label, type: 'text', why: 'field_rejected' })),
        evidenceStoragePath: evidence,
        answerPlan: storablePlan(execution.plan),
        schemaSource,
      })
    } catch (error) {
      if (error instanceof ApplicationDeferredError) throw error
      const reached = submissionMayHaveReachedProvider()
      const failureClass = classifyError(signal.aborted && lostBrowser.signal.aborted ? lostBrowser.signal.reason : error, { submitAttempted: reached })
      const page = (session as AgentSession | null)?.page
      const evidence = await persistEvidence(userId, attempt.id, page)
      const message = error instanceof Error ? error.message : String(error)
      await transition({ attemptId: attempt.id, userId, state: 'failed', detail: { message: message.slice(0, 500), failureClass } }).catch(() => undefined)
      const retry = env.APPLY_AUTO_RETRY && shouldAutoRetry(failureClass, reached, retryIndex)
      const finished = await finishAttempt(context, {
        outcome: failureClass === 'uncertain_submit' ? 'unknown' : retry ? 'retry' : 'needs_review',
        failureClass,
        ...(reached ? { submitOutcome: 'uncertain' as const } : {}),
        error: reached ? `A submit may have reached the employer before an error: ${message}` : message,
        evidenceStoragePath: evidence,
        ...(audit !== undefined ? { submittedFields: audit } : {}),
        ...(plan ? { answerPlan: storablePlan(plan) } : {}),
        schemaSource,
      }).catch((writeError: unknown) => {
        logger.error({ err: writeError, attemptId: attempt.id }, 'could not record the attempt outcome')
        return { finished: false as const }
      })
      logger.warn({ err: error, attemptId: attempt.id, failureClass, retryAt: 'retryAt' in finished ? finished.retryAt : undefined }, 'planned application ended with an error')
    } finally {
      await screencast?.stop().catch(() => undefined)
      try { await (session as AgentSession | null)?.close() } finally { await rm(scratch, { recursive: true, force: true }) }
    }
  }, async () => {
    signal.throwIfAborted()
    const [flag] = await db.select({ id: attemptFlags.id }).from(attemptFlags).where(and(eq(attemptFlags.userId, userId), eq(attemptFlags.status, 'open'))).limit(1)
    if (flag) throw new Error('Application flagged for review. Stopped before final submission.')
    const [intent] = await db.update(applyAttempts).set({ submitStartedAt: new Date(), status: 'submitting', updatedAt: new Date() })
      .where(and(eq(applyAttempts.id, attempt.id), eq(applyAttempts.userId, userId))).returning({ id: applyAttempts.id })
    if (!intent) throw new Error('Application intent disappeared; refusing submission.')
    void db.insert(attemptEvents).values({ attemptId: attempt.id, state: 'submitting', detail: { dryRun: false } }).catch(() => undefined)
    publishAttemptEvent(userId, { type: 'state', attemptId: attempt.id, state: 'submitting', reason: null, detail: { dryRun: false }, at: new Date().toISOString() })
  }, async (outcome) => {
    await recordSubmitOutcome(attempt.id, outcome).catch(() => undefined)
  })
}
