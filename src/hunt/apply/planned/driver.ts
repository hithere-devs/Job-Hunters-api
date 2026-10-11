import type { Page } from 'playwright-core'
import { logger } from '../../../lib/logger.js'
import type { PortalProfile } from '../../portal-profile.js'
import { publishAttemptEvent } from '../events.js'
import type { FilledField, FillResult } from '../fill.js'
import { actOnPage, ensureApplyPilot, snapshotPage, type PilotSnapshot } from '../pilot-page.js'
import { GENERIC, recipeFor } from '../recipes.js'
import type { BlockedReason } from '../state.js'
import type { CandidateDossier, JobContext, PlannedAnswer } from './answers.js'
import { dossierFromProfile, loadSavedAnswers } from './dossier.js'
import { attachResumeVerified, committedSatisfies, fillAll, type FieldResult } from './executor.js'
import { evaluateSubmitGate, type Blocker } from './gate.js'
import { matchFields, unclaimedRequired } from './match.js'
import { userAnswersForApplication } from './plan-questions.js'
import { planAnswers, storablePlan, unansweredRequired, type AnswerPlan, type PlannerTransport } from './planner.js'
import { fieldFromElement, schemaFromSnapshot } from './schema/dom.js'
import { loadPublishedSchema, type FormSchema, type SchemaField } from './schema/index.js'

/**
 * The planned application driver.
 *
 *   prepare (no browser): published schema → deterministic answers + one plan
 *                         call → required questions nobody can answer go to
 *                         the user before a browser is ever opened
 *   execute:              open the form → résumé first → match fields → fill
 *                         and verify each → reveal conditional fields → fill
 *                         those → re-verify everything → submit gate
 *
 * Submitting stays in `submitForm`, behind the durable fence.
 */

/** Data lookups, injectable so fixtures run without a database. */
export interface DriverLookups {
  userAnswers: typeof userAnswersForApplication
  savedAnswers: typeof loadSavedAnswers
}
const DEFAULT_LOOKUPS: DriverLookups = { userAnswers: userAnswersForApplication, savedAnswers: loadSavedAnswers }

export interface PreparedApplication {
  schema: FormSchema | null
  plan: AnswerPlan | null
  dossier: CandidateDossier
  job: JobContext
  closed: boolean
  /** Required questions the user must answer before this can be submitted. */
  missing: PlannedAnswer[]
}

export async function preparePlannedApplication(params: {
  userId: string
  applicationId: string
  urls: Array<string | null | undefined>
  profile: PortalProfile
  job: JobContext
  reuse?: AnswerPlan | null
  transport?: PlannerTransport | null
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  lookups?: DriverLookups
}): Promise<PreparedApplication> {
  const lookups = params.lookups ?? DEFAULT_LOOKUPS
  const dossier = dossierFromProfile(params.profile, await lookups.savedAnswers(params.userId).catch(() => []))
  const schema = await loadPublishedSchema(params.urls, params.fetchImpl)
  if (schema?.closed) return { schema, plan: null, dossier, job: params.job, closed: true, missing: [] }
  if (!schema) return { schema: null, plan: null, dossier, job: params.job, closed: false, missing: [] }
  const plan = await planWithUserAnswers({ userId: params.userId, applicationId: params.applicationId, schema, fields: schema.fields, dossier, job: params.job, reuse: params.reuse ?? null, transport: params.transport, signal: params.signal, lookups })
  return { schema, plan, dossier, job: params.job, closed: false, missing: unansweredRequired(plan) }
}

/** The user's own answers for this application win over planning. */
async function planWithUserAnswers(params: {
  userId: string
  applicationId: string
  schema: FormSchema
  fields: SchemaField[]
  dossier: CandidateDossier
  job: JobContext
  reuse: AnswerPlan | null
  transport?: PlannerTransport | null
  signal?: AbortSignal
  lookups: DriverLookups
}): Promise<AnswerPlan> {
  const given = await params.lookups.userAnswers(params.userId, params.applicationId, params.fields).catch(() => new Map<string, PlannedAnswer>())
  const rest = params.fields.filter((field) => !given.has(field.key))
  const planned = rest.length
    ? await planAnswers({ userId: params.userId, schema: params.schema, fields: rest, dossier: params.dossier, job: params.job, reuse: params.reuse, ...(params.transport !== undefined ? { transport: params.transport } : {}), signal: params.signal })
    : { fingerprint: params.schema.fingerprint, answers: [], model: params.reuse?.model ?? null, createdAt: new Date().toISOString() }
  const byKey = new Map([...planned.answers.map((row) => [row.key, row] as const), ...given])
  return { ...planned, answers: params.fields.map((field) => byKey.get(field.key)!).filter(Boolean) }
}

const APPLY_ENTRY = /^(?:apply(?: now| for this (?:job|position|role)| here)?|i['’]?m interested|start (?:your )?application|easy apply)$/i

/** Get the application form on screen. */
async function openForm(page: Page, schema: FormSchema | null): Promise<void> {
  const url = page.url()
  if (schema?.source === 'ashby' && !/\/application(?:[?#]|$)/.test(new URL(url).pathname) && schema.url !== url) {
    await page.goto(schema.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  } else if (/(?:^|\.)jobs\.lever\.co$/i.test(new URL(url).hostname) && !/\/apply(?:[/?#]|$)/.test(new URL(url).pathname)) {
    await page.goto(`${url.replace(/[?#].*$/, '').replace(/\/$/, '')}/apply`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  }
}

function fillable(snapshot: PilotSnapshot): number {
  return snapshot.elements.filter((element) => !['button', 'link'].includes(element.role)).length
}

async function waitForForm(page: Page, timeoutMs = 15_000): Promise<PilotSnapshot> {
  const deadline = Date.now() + timeoutMs
  let snapshot = await snapshotPage(page)
  let clickedEntry = false
  while (Date.now() < deadline) {
    if (fillable(snapshot) >= 2 && snapshot.looksLikeForm) return snapshot
    if (!clickedEntry) {
      const entry = snapshot.elements.find((element) => (element.role === 'button' || element.role === 'link') && APPLY_ENTRY.test(element.label.trim()))
      if (entry) {
        clickedEntry = true
        await actOnPage(page, { op: 'click', id: entry.id }).catch(() => undefined)
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 600))
    await ensureApplyPilot(page).catch(() => undefined)
    snapshot = await snapshotPage(page).catch(() => snapshot)
  }
  return snapshot
}

export interface PlannedExecution extends FillResult {
  canSubmit: boolean
  plan: AnswerPlan
  schema: FormSchema
  results: FieldResult[]
  blockers: Blocker[]
  resumeAttached: boolean
}

function auditFrom(results: FieldResult[], answers: Map<string, PlannedAnswer>): FilledField[] {
  return results.map((result) => {
    const answer = answers.get(result.key)
    return {
      label: result.label,
      via: answer?.basis === 'model' || answer?.basis === 'resume' ? 'model' as const : answer?.basis === 'derived' ? 'derived' as const : answer?.basis === 'policy' ? 'consent' as const : 'heuristic' as const,
      filled: result.status === 'filled',
      value: answer?.sensitive ? '' : result.committed.slice(0, 500),
      source: answer?.basis === 'saved_answer' ? 'cache' : answer?.basis ?? 'none',
    } as FilledField
  })
}

function unresolvedFrom(blockers: Blocker[]): FillResult['unresolved'] {
  const why = (reason: Blocker['reason']): BlockedReason => reason === 'needs_answer' || reason === 'unfilled_required' ? 'needs_input'
    : reason === 'resume_missing' ? 'field_rejected'
      : reason === 'no_submit_control' ? 'no_form'
        : 'field_rejected'
  return blockers.map((blocker) => ({ label: blocker.label, type: 'text', why: why(blocker.reason) }))
}

export async function executePlannedApplication(params: {
  page: Page
  prepared: PreparedApplication
  userId: string
  applicationId: string
  attemptId: string
  resumePath: string
  transport?: PlannerTransport | null
  signal?: AbortSignal
  lookups?: DriverLookups
}): Promise<PlannedExecution> {
  const { page, prepared } = params
  const lookups = params.lookups ?? DEFAULT_LOOKUPS
  await openForm(page, prepared.schema)
  await ensureApplyPilot(page)
  let snapshot = await waitForForm(page)
  const schema: FormSchema = prepared.schema ?? schemaFromSnapshot(snapshot, page.url())
  let plan = prepared.plan ?? await planWithUserAnswers({ userId: params.userId, applicationId: params.applicationId, schema, fields: schema.fields, dossier: prepared.dossier, job: prepared.job, reuse: null, transport: params.transport, signal: params.signal, lookups })
  const fields: SchemaField[] = [...schema.fields]
  const answers = new Map(plan.answers.map((row) => [row.key, row]))
  const results = new Map<string, FieldResult>()
  const submitSelector = (recipeFor(page.url()) ?? GENERIC).submit
  const emit = (result: FieldResult) => publishAttemptEvent(params.userId, { type: 'field', attemptId: params.attemptId, label: result.label, via: answers.get(result.key)?.basis === 'model' ? 'model' : 'heuristic', filled: result.status === 'filled' })

  // Résumé first: parsers autofill (and overwrite) other fields on upload.
  let matches = matchFields(fields, snapshot.elements)
  const resumeField = fields.find((field) => field.kind === 'file' && field.fileRole === 'resume')
  const resumeElement = resumeField ? matches.find((match) => match.field.key === resumeField.key)?.element ?? null : null
  const resumeAttached = await attachResumeVerified(page, resumeElement, params.resumePath).catch(() => false)
  if (resumeField) results.set(resumeField.key, { key: resumeField.key, label: resumeField.label, status: resumeAttached ? 'filled' : 'failed', committed: resumeAttached ? 'résumé' : '', attempts: 1 })
  snapshot = await snapshotPage(page)

  for (let round = 0; round < 4; round += 1) {
    params.signal?.throwIfAborted()
    matches = matchFields(fields, snapshot.elements)
    // Required inputs the schema does not describe: conditional questions
    // revealed by earlier answers, or fields the ATS does not publish.
    const extras = unclaimedRequired(snapshot.elements, matches)
      .map(fieldFromElement)
      .filter((field): field is SchemaField => field !== null && !fields.some((known) => known.key === field.key))
    if (extras.length) {
      fields.push(...extras)
      const more = await planWithUserAnswers({ userId: params.userId, applicationId: params.applicationId, schema, fields: extras, dossier: prepared.dossier, job: prepared.job, reuse: null, transport: params.transport, signal: params.signal, lookups })
      for (const row of more.answers) answers.set(row.key, row)
      plan = { ...plan, answers: [...plan.answers, ...more.answers] }
      matches = matchFields(fields, snapshot.elements)
    }
    const todo = matches.filter((match) => {
      const answer = answers.get(match.field.key)
      if (!answer || answer.action === 'upload_resume' || !match.element) return false
      const done = results.get(match.field.key)
      if (done?.status === 'filled' && match.element.filled) return false
      if (done && done.status === 'failed' && done.attempts >= 6) return false
      return answer.action === 'fill' ? !(match.element.filled && committedSatisfies(answer, match.element.value)) : !done
    })
    if (!todo.length && !extras.length) break
    const filled = await fillAll({
      page,
      snapshot,
      resumePath: params.resumePath,
      pairs: todo.map((match) => ({ field: match.field, element: match.element, answer: answers.get(match.field.key)! })),
      onResult: emit,
    })
    for (const result of filled) {
      const earlier = results.get(result.key)
      results.set(result.key, { ...result, attempts: (earlier?.attempts ?? 0) + result.attempts })
    }
    snapshot = await snapshotPage(page)
  }

  // Phone fields on intl-tel-input forms validate against the country widget.
  const countryWidget = snapshot.elements.find((element) => /^phone country code$/i.test(element.label) && !element.filled)
  if (countryWidget && prepared.dossier.location.country) {
    await actOnPage(page, { op: 'fill', id: countryWidget.id, value: prepared.dossier.location.country }).catch(() => undefined)
    snapshot = await snapshotPage(page)
  }

  // Final read-back: anything a re-render or the résumé parser undid is written once more.
  matches = matchFields(fields, snapshot.elements)
  const lost = matches.filter((match) => {
    const answer = answers.get(match.field.key)
    return answer?.action === 'fill' && match.element && !(match.element.filled && committedSatisfies(answer, match.element.value))
  })
  if (lost.length) {
    logger.info({ attemptId: params.attemptId, lost: lost.map((match) => match.field.label).slice(0, 8) }, 'refilling fields that lost their values')
    const refilled = await fillAll({ page, snapshot, resumePath: params.resumePath, pairs: lost.map((match) => ({ field: match.field, element: match.element, answer: answers.get(match.field.key)! })), onResult: emit })
    for (const result of refilled) results.set(result.key, result)
    snapshot = await snapshotPage(page)
    matches = matchFields(fields, snapshot.elements)
  }

  const gate = await evaluateSubmitGate({ page, snapshot, fields, matches, answers, results, resumeAttached: resumeAttached || !resumeField?.required, submitSelector })
  const resultList = [...results.values()]
  logger.info({ attemptId: params.attemptId, source: schema.source, fields: fields.length, filled: resultList.filter((row) => row.status === 'filled').length, blockers: gate.blockers.map((blocker) => `${blocker.reason}:${blocker.label}`).slice(0, 10) }, 'planned application filled')
  return {
    fields: auditFrom(resultList, answers),
    unresolved: unresolvedFrom(gate.blockers),
    recipe: `planned:${schema.source}`,
    canSubmit: gate.ok,
    plan,
    schema: { ...schema, fields },
    results: resultList,
    blockers: gate.blockers,
    resumeAttached,
  }
}

export { storablePlan }
