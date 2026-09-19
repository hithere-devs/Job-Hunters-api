import { text as modelText } from '../../model/gateway.js'
import type { CandidateState } from './candidate-state.js'
import { compactCandidate } from './candidate-state.js'
import { kitSuggestion } from './apply-preferences.js'
import { jevDecide, jevRead, type JevChoice, type JevDecideParams } from './jev-client.js'
import type { PilotElement } from './pilot-page.js'

export type AnswerSource = 'profile' | 'jev' | 'model' | 'none'

export interface ResolvedPilotAnswer {
  value: string | null
  source: AnswerSource
  reason?: string
}

const PROFILE_RULES: Array<[RegExp, (candidate: CandidateState) => string]> = [
  [/^(?:legal\s+)?(?:full\s+)?name$|^applicant(?:'s)?\s+name$|^your\s+name$/i, (c) => c.name],
  [/first\s*name|given\s*name|forename/i, (c) => c.first_name],
  [/last\s*name|surname|family\s*name/i, (c) => c.last_name],
  [/\be-?mail\b/i, (c) => c.email],
  [/\b(?:phone|mobile|cell|telephone)\b/i, (c) => c.phone],
  [/^city$|current\s+city/i, (c) => c.location.city],
  [/^state$|^region$|province/i, (c) => c.location.region],
  [/\bcountry\b/i, (c) => c.location.country],
  [/postal|zip\s*code/i, (c) => c.location.postal_code],
  [/address\s*line\s*1|^street$|street\s+address/i, (c) => c.location.line1],
  [/address\s*line\s*2|apartment|suite/i, (c) => c.location.line2],
  [/^location$|location\s*\(.*city|current\s+location|where\s+are\s+you\s+(?:based|located)/i, (c) => c.location.city || [c.location.city, c.location.region, c.location.country].filter(Boolean).join(', ')],
  [/preferred\s+name|nickname/i, (c) => c.first_name],
  [/linkedin/i, (c) => c.links.linkedin],
  [/github/i, (c) => c.links.github],
  [/portfolio|personal\s+site|website|homepage/i, (c) => c.links.portfolio],
  [/years?\s+of\s+experience|total\s+experience/i, (c) => c.experience_years],
  [/notice\s+period/i, (c) => c.notice_period],
  [/current\s+(?:ctc|salary|compensation)/i, (c) => c.current_ctc],
  [/expected\s+(?:ctc|salary|compensation)|salary\s+expectation/i, (c) => c.expected_ctc],
  [/current\s+company|employer/i, (c) => c.experience.find((row) => row.current)?.company ?? c.experience[0]?.company ?? ''],
  [/current\s+(?:title|role|position)/i, (c) => c.experience.find((row) => row.current)?.role ?? c.experience[0]?.role ?? ''],
  [/headline|professional\s+title/i, (c) => c.headline],
]

export function profileValue(element: PilotElement, candidate: CandidateState): string | null {
  const fromKit = kitSuggestion({ label: element.label, options: element.options, candidate }).value
  if (fromKit) return fromKit
  const label = element.label.trim()
  for (const [pattern, read] of PROFILE_RULES) {
    if (!pattern.test(label)) continue
    const value = read(candidate).trim()
    return value || null
  }
  return null
}

function optionCriteria(options: string[]): Record<string, string> {
  const criteria: Record<string, string> = {}
  options.slice(0, 24).forEach((option, index) => {
    criteria[`o${index}`] = option.slice(0, 180)
  })
  return criteria
}

function jobState(candidate: CandidateState) {
  return {
    title: candidate.job?.title ?? '',
    company: candidate.job?.company ?? '',
    location: candidate.job?.location ?? null,
    description: (candidate.job?.description ?? '').slice(0, 800),
  }
}

function thisJobLine(candidate: CandidateState): string {
  const job = jobState(candidate)
  const where = job.location ? ` in ${job.location}` : ''
  return job.title || job.company
    ? `The candidate is applying to ${job.title || 'this role'} at ${job.company || 'this company'}${where}. Decide for THIS posting, not a generic application.`
    : 'Decide for this specific job application, not a generic default.'
}

export async function pickOptionWithJev(params: {
  element: PilotElement
  candidate: CandidateState
  userId: string
  signal?: AbortSignal
  decide?: (input: JevDecideParams) => ReturnType<typeof jevDecide>
}): Promise<string | null> {
  const options = params.element.options.filter(Boolean)
  if (!options.length) return null
  if (options.length === 1) return options[0] ?? null
  const criteria = optionCriteria(options)
  const suggested = profileValue(params.element, params.candidate)
  const hint = kitSuggestion({ label: params.element.label, options, candidate: params.candidate })
  const decide = params.decide ?? jevDecide
  const response = await decide({
    userId: params.userId,
    signal: params.signal,
    state: {
      job: jobState(params.candidate),
      question: params.element.label,
      required: params.element.required,
      options,
      suggested_from_kit: suggested,
      question_kind: hint.kind,
      kit_rule: hint.instruction,
      kit_overrides_review_answers: true,
      candidate: compactCandidate(params.candidate),
      full_page_context_note: 'Use the entire candidate record, job location, work mode, and Kit preferences even if a field looks unrelated.',
    },
    questions: {
      pick: {
        type: 'choice',
        instructions: `${thisJobLine(params.candidate)} ${hint.instruction} My Kit is the source of truth and beats any review-application answer. Choose the closest dropdown/radio/checkbox option. For comboboxes the extension will type then click the matching option. Never invent facts.`,
        criteria,
      } satisfies JevChoice,
    },
  })
  const key = jevRead.choice(response.answers.pick)
  if (!key) return null
  return criteria[key] ?? options.find((option) => option === key) ?? null
}

export async function draftWithDeepSeek(params: {
  element: PilotElement
  candidate: CandidateState
  userId: string
  signal?: AbortSignal
}): Promise<string | null> {
  const job = jobState(params.candidate)
  const prompt = [
    'Write a short application answer in the candidate\'s voice for THIS job.',
    `Job: ${job.title} at ${job.company} (${job.location || 'location unknown'}).`,
    job.description ? `Job excerpt: ${job.description}` : '',
    'Use only facts from the candidate record. Do not invent employers, visas, degrees, or dates.',
    'Tie the answer to this posting when the question asks why this role or company.',
    'Return only the answer text. No quotes, no preamble.',
    params.element.role === 'textarea' ? '80-140 words.' : 'One or two sentences.',
    '',
    `Question: ${params.element.label}`,
    'My Kit is the source of truth and beats review-application answers.',
    `Candidate: ${JSON.stringify(compactCandidate(params.candidate))}`,
  ].filter(Boolean).join('\n')
  const drafted = await modelText({
    userId: params.userId,
    purpose: 'apply-draft',
    think: false,
    maxTokens: 400,
    prompt,
    signal: params.signal,
  })
  const value = drafted.trim()
  return value || null
}

export async function resolvePilotAnswer(params: {
  element: PilotElement
  candidate: CandidateState
  userId: string
  signal?: AbortSignal
  decide?: (input: JevDecideParams) => ReturnType<typeof jevDecide>
}): Promise<ResolvedPilotAnswer> {
  const { element, candidate, userId, signal } = params
  const decide = params.decide ?? jevDecide
  if (element.role === 'file' || element.role === 'button' || element.role === 'link') {
    return { value: null, source: 'none' }
  }

  const suggested = profileValue(element, candidate)
  const hint = kitSuggestion({ label: element.label, options: element.options, candidate })
  if (hint.kind !== 'other' && hint.value) {
    return { value: hint.value, source: 'profile' }
  }
  if (element.options.length > 0) {
    const picked = await pickOptionWithJev({ element, candidate, userId, signal, decide })
    if (picked) return { value: picked, source: suggested && picked.toLowerCase().includes(suggested.toLowerCase()) ? 'profile' : 'jev' }
    if (suggested) return { value: suggested, source: 'profile' }
    return { value: null, source: 'none', reason: 'no_option' }
  }

  const response = await decide({
    userId,
    signal,
    state: {
      job: jobState(candidate),
      question: element.label,
      role: element.role,
      required: element.required,
      suggested_from_kit: suggested,
      question_kind: hint.kind,
      kit_rule: hint.instruction,
      kit_overrides_review_answers: true,
      candidate: compactCandidate(candidate),
    },
    questions: {
      action: {
        type: 'choice',
        instructions: `${thisJobLine(candidate)} ${hint.instruction} My Kit beats review-application answers. fill_profile = write suggested_from_kit. draft = write a job-specific free-text answer from candidate facts. skip = leave empty. ask = a human must answer.`,
        criteria: {
          fill_profile: 'The suggested profile fact is true for this job and this field',
          draft: 'Needs a short written answer about this job, using only known facts',
          skip: 'Leave blank. Optional, or not applicable to this posting',
          ask: 'Missing a fact. Park for the user',
        },
      } satisfies JevChoice,
    },
  })
  const action = jevRead.choice(response.answers.action)
  if (action === 'skip') return { value: null, source: 'none', reason: 'skip' }
  if (action === 'ask') return { value: null, source: 'none', reason: 'unknown_field' }
  if (action === 'fill_profile' && suggested) return { value: suggested, source: 'profile' }
  if (action === 'draft' || (action === 'fill_profile' && !suggested)) {
    const drafted = await draftWithDeepSeek({ element, candidate, userId, signal })
    if (!drafted) return { value: null, source: 'none', reason: 'unknown_field' }
    const check = await decide({
      userId,
      signal,
      state: {
        job: jobState(candidate),
        question: element.label,
        draft: drafted,
        candidate: compactCandidate(candidate),
      },
      questions: {
        ok: {
          type: 'noul',
          instructions: `${thisJobLine(candidate)} Is this draft a truthful answer to the question for this candidate and this job? It must not invent employers, visas, degrees, or dates, and it must not contradict the candidate record.`,
          criteria: { true: 'Truthful and on-topic for this job', false: 'Invented, off-topic, or unsafe' },
        },
      },
    })
    if (jevRead.noul(check.answers.ok) < 0.55) return { value: null, source: 'none', reason: 'unknown_field' }
    return { value: drafted, source: 'model' }
  }
  if (suggested) return { value: suggested, source: 'profile' }
  return { value: null, source: 'none', reason: 'unknown_field' }
}
