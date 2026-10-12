import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod/v4'
import { env, hasAnthropicPlanner, hasModelAccess } from '../../../config/env.js'
import { logger } from '../../../lib/logger.js'
import { structured } from '../../../model/gateway.js'
import { assertWithinBudget, recordUsage } from '../../../model/meter.js'
import { deterministicAnswer, savedAnswerFor, validateModelAnswer, type AnswerBasis, type CandidateDossier, type JobContext, type PlannedAnswer } from './answers.js'
import type { FormSchema, SchemaField } from './schema/types.js'

/**
 * One planning call per application.
 *
 * The previous loop asked a multiple-choice classifier three independent
 * questions per step from a truncated element list, with no résumé, no
 * education and the first 24 options of any dropdown. This sees the whole
 * form, every option, the full résumé and the user's own earlier answers, and
 * answers everything at once; code then validates each answer against the
 * ATS's exact options before anything is typed.
 */

export interface AnswerPlan {
  fingerprint: string
  answers: PlannedAnswer[]
  model: string | null
  createdAt: string
}

const SYSTEM = `You complete job application forms on behalf of one candidate. For every form field you are given, decide the answer using ONLY the candidate dossier and the job. You are not writing to the candidate; your output goes straight into the form.

Rules:
- Choice fields (select, boolean, multiselect): copy option labels verbatim from the field's options. Multi-select may take several; choose all that truthfully apply (for "select both if appropriate" office questions, choose every office the candidate would work from).
- Never invent facts: employers, titles, dates, degrees, schools, grades, visas, licences, numbers, or links. If the dossier does not support a factual answer, use action "ask".
- Free-text questions about motivation or experience ("Why X?", "Describe a project", "What would you work on?"): write a specific, honest answer in the candidate's first-person voice, grounded in résumé facts and this job's description. 60-160 words for textareas, one or two sentences for short text fields. No greetings, no sign-off, no placeholders, no markdown.
- Location, office, relocation, time zone and on-site questions: reason from the candidate's city and country, work mode, relocation preference and the job's location. Answer what is literally asked (currently based there vs. willing to relocate are different).
- Work authorization and visa sponsorship: decide only from explicit dossier facts (workAuthorization, visaSponsorship) and the candidate's saved answers. If they do not settle it for this job's country, use "ask".
- Demographic (EEO) questions: only from explicit dossier eeo values. Otherwise pick an option that declines to answer if one exists; else "ask".
- Salary or compensation: only from dossier currentCtc/expectedCtc, in the format the field expects; else "ask".
- "How did you hear about us": pick LinkedIn, a job board, or the company website, whichever is offered.
- "Have you worked/interviewed here before": No, unless the dossier's experience or saved answers show otherwise.
- Education fields (degree, school, graduation year, GPA): only from the dossier's education text or résumé; else "ask".
- Acknowledgements, policy and arbitration confirmations required to apply: agree.
- Optional fields with no good truthful answer: "skip".
- basis: kit (from structured dossier facts), saved_answer (the candidate's own earlier answer), resume (from résumé text), derived (follows logically from stated facts), model (your judgement for a non-factual field).
- confidence: 0 to 1, how sure you are that the answer is true for this candidate and appropriate for this field.
Return every field key you were given exactly once, in any order.`

const PlanOutput = z.object({
  answers: z.array(z.object({
    key: z.string(),
    action: z.enum(['fill', 'skip', 'ask']),
    values: z.array(z.string()),
    basis: z.enum(['kit', 'resume', 'saved_answer', 'derived', 'model']),
    confidence: z.number(),
    reason: z.string(),
  })),
})
type PlanOutputT = z.infer<typeof PlanOutput>

function dossierForModel(dossier: CandidateDossier) {
  // Contact details the deterministic layer owns are omitted: the model never
  // needs to retype an email or phone number, and less PII leaves the box.
  return {
    name: dossier.fullName,
    headline: dossier.headline,
    location: { city: dossier.location.city, region: dossier.location.region, country: dossier.location.country },
    links: dossier.links,
    totalExperience: dossier.totalExperience,
    currentCompany: dossier.currentCompany,
    currentTitle: dossier.currentTitle,
    noticePeriod: dossier.noticePeriod,
    currentCtc: dossier.currentCtc,
    expectedCtc: dossier.expectedCtc,
    workMode: dossier.workMode,
    willingToRelocate: dossier.relocate,
    workAuthorization: dossier.workAuthorization,
    visaSponsorship: dossier.visaSponsorship,
    boundByAgreements: dossier.boundByAgreements,
    eeo: dossier.eeo,
    experience: dossier.experience,
    education: dossier.education,
    skills: dossier.skills,
    savedAnswers: dossier.savedAnswers,
    resumeText: dossier.resumeText,
  }
}

function fieldForModel(field: SchemaField) {
  return {
    key: field.key,
    label: field.label,
    ...(field.description ? { description: field.description } : {}),
    kind: field.kind,
    required: field.required,
    ...(field.options.length ? { options: field.options.slice(0, 400).map((option) => option.label) } : {}),
  }
}

export interface PlannerTransport {
  plan(input: { userId: string; dossierText: string; requestText: string; signal?: AbortSignal }): Promise<{ output: PlanOutputT; model: string }>
}

let anthropicClient: Anthropic | undefined

const supportsFallbacks = (model: string) => /^claude-(?:opus-5|sonnet-5-5|fable-5)/.test(model)

/** Claude directly: cached system prompt and dossier, structured output, refusal fallback. */
export const anthropicTransport: PlannerTransport = {
  async plan({ userId, dossierText, requestText, signal }) {
    const model = env.APPLY_PLAN_MODEL
    anthropicClient ??= new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      timeout: 180_000,
      maxRetries: 2,
      // Org-level keys must name a workspace on every request.
      ...(env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID } } : {}),
    })
    await assertWithinBudget(userId)
    const startedAt = Date.now()
    try {
      const response = await anthropicClient.beta.messages.parse({
        model,
        max_tokens: 16_000,
        ...(supportsFallbacks(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        output_config: { effort: env.APPLY_PLAN_EFFORT, format: betaZodOutputFormat(PlanOutput) },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: [
            // Stable per user across a batch: cached after the first application.
            { type: 'text', text: dossierText, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: requestText },
          ],
        }],
      }, { signal })
      await recordUsage({ userId, purpose: 'apply-plan', model: response.model || model, usage: response.usage, durationMs: Date.now() - startedAt, ok: true })
      if (response.stop_reason === 'refusal') throw new Error('The answer planner declined this request.')
      if (response.stop_reason === 'max_tokens') throw new Error('The answer planner ran out of output tokens.')
      if (!response.parsed_output) throw new Error('The answer planner returned no parsable plan.')
      return { output: response.parsed_output, model: response.model || model }
    } catch (error) {
      if (!(error instanceof Error && /declined|ran out|no parsable/.test(error.message))) {
        await recordUsage({ userId, purpose: 'apply-plan', model, usage: undefined, durationMs: Date.now() - startedAt, ok: false, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined)
      }
      throw error
    }
  },
}

/** The configured gateway provider, when no Anthropic key is available. */
export const gatewayTransport: PlannerTransport = {
  async plan({ userId, dossierText, requestText, signal }) {
    const output = await structured(PlanOutput, { purpose: 'apply-plan', userId, system: SYSTEM, prompt: `${dossierText}\n\n${requestText}`, maxTokens: 16_000, effort: 'medium', signal })
    return { output, model: env.MODEL_DEFAULT }
  },
}

/**
 * Claude first; the configured gateway if Claude is refused for account
 * reasons (no credits, invalid or unscoped key). Adding credits switches back
 * without a configuration change. Transient errors are not masked here: they
 * fail the attempt and it is retried with backoff.
 */
async function planWithFallback(transport: PlannerTransport, input: Parameters<PlannerTransport['plan']>[0]) {
  try {
    return await transport.plan(input)
  } catch (error) {
    const accountProblem = error instanceof Anthropic.AuthenticationError
      || error instanceof Anthropic.PermissionDeniedError
      || (error instanceof Anthropic.BadRequestError && /credit balance|billing|workspace/i.test(error.message))
    if (transport !== anthropicTransport || !accountProblem || !hasModelAccess) throw error
    if (!warnedFallback) {
      warnedFallback = true
      logger.warn({ err: error }, 'Claude planner unavailable for account reasons; planning with the configured gateway model')
    }
    return gatewayTransport.plan(input)
  }
}
let warnedFallback = false

export function defaultTransport(): PlannerTransport | null {
  if (hasAnthropicPlanner) return anthropicTransport
  if (hasModelAccess) return gatewayTransport
  return null
}

/**
 * Decide every field. Deterministic answers never reach the model; the rest go
 * in one call. A field the model omits, or answers outside its options, becomes
 * a question for the user (required) or is left blank (optional).
 */
export async function planAnswers(params: {
  userId: string
  schema: FormSchema
  fields?: SchemaField[]
  dossier: CandidateDossier
  job: JobContext
  transport?: PlannerTransport | null
  signal?: AbortSignal
  reuse?: AnswerPlan | null
}): Promise<AnswerPlan> {
  const fields = params.fields ?? params.schema.fields
  const answers = new Map<string, PlannedAnswer>()
  const pending: SchemaField[] = []
  // Reuse model answers from an earlier plan for the same form (a deferred or
  // retried attempt), never redacted placeholders or earlier "ask" verdicts:
  // the user may have answered since.
  const reusable = new Map((params.reuse?.answers ?? [])
    .filter((row) => row.basis === 'model' || row.basis === 'resume' || row.basis === 'saved_answer')
    .filter((row) => row.action === 'fill' && !row.values.includes('[redacted]'))
    .map((row) => [row.key, row]))
  for (const field of fields) {
    const decided = deterministicAnswer(field, params.dossier, params.job)
    if (decided && decided.action !== 'ask') { answers.set(field.key, decided); continue }
    const saved = savedAnswerFor(field, params.dossier.savedAnswers)
    if (saved) { answers.set(field.key, saved); continue }
    if (decided) { answers.set(field.key, decided); continue }
    const earlier = reusable.get(field.key)
    if (earlier && earlier.label === field.label) { answers.set(field.key, earlier); continue }
    pending.push(field)
  }
  let model: string | null = params.reuse?.model ?? null
  if (pending.length) {
    const transport = params.transport === undefined ? defaultTransport() : params.transport
    let output: PlanOutputT | null = null
    if (transport) {
      try {
        const result = await planWithFallback(transport, {
          userId: params.userId,
          signal: params.signal,
          dossierText: `CANDIDATE DOSSIER (JSON)\n${JSON.stringify(dossierForModel(params.dossier))}`,
          requestText: `TODAY: ${new Date().toISOString().slice(0, 10)}\n\nJOB (JSON)\n${JSON.stringify({ title: params.job.title, company: params.job.company, location: params.job.location, countries: params.job.countries, remote: params.job.remote, description: params.job.description })}\n\nFORM FIELDS TO ANSWER (JSON)\n${JSON.stringify(pending.map(fieldForModel))}`,
        })
        output = result.output
        model = result.model
      } catch (error) {
        logger.warn({ err: error, fields: pending.length }, 'answer planner failed; unanswered required fields become questions')
        throw error
      }
    }
    const proposed = new Map((output?.answers ?? []).map((row) => [row.key, row]))
    for (const field of pending) {
      const row = proposed.get(field.key)
      answers.set(field.key, row
        ? validateModelAnswer(field, { action: row.action, values: row.values, basis: row.basis as AnswerBasis, confidence: row.confidence, reason: row.reason }, params.dossier.savedAnswers)
        : validateModelAnswer(field, { action: 'ask', values: [], basis: 'model', confidence: 0, reason: transport ? 'The planner did not answer this field.' : 'No answer planner is configured.' }))
    }
  }
  return {
    fingerprint: params.schema.fingerprint,
    answers: fields.map((field) => answers.get(field.key)!).filter(Boolean),
    model,
    createdAt: new Date().toISOString(),
  }
}

/** Required questions that still need the user. */
export function unansweredRequired(plan: AnswerPlan): PlannedAnswer[] {
  return plan.answers.filter((row) => row.required && row.action === 'ask')
}

/** The plan as stored on the attempt: sensitive values redacted. */
export function storablePlan(plan: AnswerPlan): AnswerPlan {
  return {
    ...plan,
    answers: plan.answers.map((row) => row.sensitive && row.basis !== 'policy' ? { ...row, values: row.values.map(() => '[redacted]') } : row),
  }
}
