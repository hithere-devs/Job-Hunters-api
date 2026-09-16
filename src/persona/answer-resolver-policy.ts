import { credentialFieldReason, sensitiveReason, validExplicitAnswer, type FormField } from '../hunt/apply/fields.js'

export type AnswerTopic = 'professional' | 'contact' | 'salary_current' | 'salary_expected' | 'sponsorship' | 'work_authorization' | 'gender' | 'pronouns' | 'ethnicity' | 'disability' | 'veteran' | 'legal' | 'credential'
export interface AnswerSource { id: string; label: string; text: string; kind: 'profile' | 'resume' | 'explicit_answer'; topic: AnswerTopic; applicationId?: string; country?: string | null }
export interface ResolverQuestion extends FormField { id: string; applicationId: string; role: string; company: string; location: string | null }
export interface AnswerEvidence { sourceId: string; quote: string }
export interface ResolvedApplicationAnswer { questionId: string; decision: 'known' | 'draft' | 'ask'; answer: string | null; confidence: number; evidence: AnswerEvidence[]; reason: string; missingInfo: string[]; autoApply: boolean }
export type ProposedAnswer = Omit<ResolvedApplicationAnswer, 'autoApply'>

export function answerTopic(field: Pick<FormField, 'label' | 'type' | 'name' | 'options'>): AnswerTopic {
  if (credentialFieldReason({ ...field, required: false })) return 'credential'
  const label = field.label
  const all = `${label} ${(field.options ?? []).join(' ')}`
  if (/\b(?:gender|male|female|non.?binary|sexual orientation)\b/i.test(all)) return 'gender'
  if (/\bpronouns\b/i.test(label)) return 'pronouns'
  if (/\b(?:race|ethnic\w*|hispanic|latino|asian|black|white|native hawaiian)\b/i.test(all)) return 'ethnicity'
  if (/\bdisabilit\w*/i.test(label)) return 'disability'
  if (/\bveteran\b/i.test(label)) return 'veteran'
  if (/\bsponsor\w*/i.test(label)) return 'sponsorship'
  if (/\b(?:visa|citizen\w*|nationality|authori[sz]\w*|eligible to work|right to work|permission to work)\b/i.test(label)) return 'work_authorization'
  if (/\b(?:salary|compensation|ctc|remuneration|pay range)\b/i.test(label)) return /\b(?:current|present|previous|last|history)\b/i.test(label) ? 'salary_current' : 'salary_expected'
  if (sensitiveReason(label, field.options) || /\b(?:certif\w*|attest\w*|declaration|employment contract|legally binding|legal obligation)\b/i.test(label)) return 'legal'
  if (/\b(?:name|email|e-mail|phone|mobile|address|city|country|postal|zip|linkedin|linked.in|github|portfolio|website|profile link)\b/i.test(label)) return 'contact'
  return 'professional'
}

const COUNTRIES: Array<[string, RegExp]> = [
  ['US', /\b(?:USA|U\.S\.A\.?|US|[Uu]nited [Ss]tates(?: of [Aa]merica)?)\b/g],
  ['IN', /\bIndia\b/gi], ['GB', /\b(?:UK|United Kingdom|Great Britain)\b/gi],
  ['CA', /\bCanada\b/gi], ['AU', /\bAustralia\b/gi], ['DE', /\bGermany\b/gi],
  ['SG', /\bSingapore\b/gi], ['FR', /\bFrance\b/gi], ['NL', /\bNetherlands\b/gi],
]
export function countriesIn(text: string): string[] {
  return COUNTRIES.filter(([, regex]) => { regex.lastIndex = 0; return regex.test(text) }).map(([code]) => code)
}
export function countryForQuestion(question: ResolverQuestion): string | null {
  const explicit = countriesIn(question.label)
  if (explicit.length === 1) return explicit[0]!
  if (explicit.length > 1) return null
  const locations = countriesIn(question.location ?? '')
  return locations.length === 1 ? locations[0]! : null
}

export function askAnswer(question: ResolverQuestion, reason: string, missingInfo?: string[]): ResolvedApplicationAnswer {
  const prompts = (missingInfo ?? ['Please provide the missing fact for this question.']).map((prompt) => credentialFieldReason({ label: prompt, type: 'text', required: false }) ? 'Complete authentication in browser setup; do not send secrets here.' : prompt)
  return { questionId: question.id, decision: 'ask', answer: null, confidence: 0, evidence: [], reason, missingInfo: reason === 'credential_field' ? ['Complete authentication in browser setup; do not send secrets here.'] : prompts, autoApply: false }
}
const normalized = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim()
const binary = (value: string): 'yes' | 'no' | null => /^(?:yes|true)\b/i.test(value.trim()) ? 'yes' : /^(?:no|false)\b/i.test(value.trim()) ? 'no' : null

/** Deliberately bounded: explicit country/answer clauses, never inferred citizenship. */
export function conditionalCountryAnswer(source: AnswerSource, country: string): 'yes' | 'no' | null {
  const exact = binary(source.text)
  if (exact && /^(?:yes|no|true|false)[.! ]*$/i.test(source.text.trim())) return source.country === country ? exact : null
  const answers = new Set<'yes' | 'no'>()
  const clauses = source.text.split(/[;,\n]|\bbut\b|\bhowever\b/i)
  for (const clause of clauses) {
    const countries = countriesIn(clause)
    if (countries.length !== 1 || countries[0] !== country) continue
    const polarities = [...clause.matchAll(/\b(yes|no|true|false)\b/gi)].map((match) => binary(match[0])!)
    if (polarities.length === 1) { answers.add(polarities[0]!); continue }
    if (polarities.length > 1) continue
    if (/\b(?:not|don't|do not|does not|without)\b[\s\S]{0,45}\b(?:need|require|sponsor\w*|authori[sz]\w*)\b|\bno\s+sponsorship/i.test(clause)) answers.add('no')
    else if (/\b(?:need|require)\b[\s\S]{0,35}\bsponsor\w*/i.test(clause) || (source.topic === 'work_authorization' && /\b(?:authori[sz]ed|eligible|right to work)\b/i.test(clause))) answers.add('yes')
  }
  return answers.size === 1 ? [...answers][0]! : null
}

export function sourcesForQuestion(question: ResolverQuestion, sources: AnswerSource[]): AnswerSource[] {
  const topic = answerTopic(question)
  if (topic === 'credential' || topic === 'legal') return []
  return sources.filter((source) => {
    if (source.topic === 'credential' || source.topic === 'legal') return false
    if (topic === 'professional' || topic === 'contact') {
      const essay = /\b(?:why|motivat\w*|cover\s*letter|describe|tell\s+us|example|a time|personal story)\b/i.test(question.label)
      return source.topic === 'professional' || (!essay && source.topic === 'contact')
    }
    return source.kind === 'explicit_answer' && source.topic === topic
  })
}

function salaryContextMatches(question: ResolverQuestion, source: AnswerSource): boolean {
  const currency = (text: string) => [...text.toUpperCase().matchAll(/\b(?:USD|INR|GBP|EUR|CAD|AUD)\b|₹|£|€/g)].map((match) => ({ '₹': 'INR', '£': 'GBP', '€': 'EUR' }[match[0]] ?? match[0]))
  const requested = currency(question.label)
  const known = currency(`${source.label} ${source.text}`)
  if (requested.length && !requested.every((value) => known.includes(value))) return false
  const period = (text: string) => /month|monthly/i.test(text) ? 'month' : /annual|year/i.test(text) ? 'year' : /hour/i.test(text) ? 'hour' : null
  const askedPeriod = period(question.label)
  return !askedPeriod || period(`${source.label} ${source.text}`) === askedPeriod
}

/** Model confidence is insufficient. Evidence and exact field/context checks determine usability. */
export function validateAnswerProposal(question: ResolverQuestion, sources: AnswerSource[], proposed: ProposedAnswer): ResolvedApplicationAnswer {
  const topic = answerTopic(question)
  if (topic === 'credential') return askAnswer(question, 'credential_field', ['Complete authentication yourself in browser setup. Do not send secrets in chat.'])
  if (topic === 'legal') return askAnswer(question, 'application_specific_legal_question', ['Confirm this obligation for this application yourself.'])
  if (proposed.questionId !== question.id || proposed.decision === 'ask' || !proposed.answer) return askAnswer(question, proposed.reason || 'missing_fact', proposed.missingInfo)
  const allowed = new Map(sourcesForQuestion(question, sources).map((source) => [source.id, source]))
  const evidence = proposed.evidence.filter((entry) => entry.quote.trim().length > 0 && allowed.get(entry.sourceId)?.text.includes(entry.quote))
  if (!evidence.length || evidence.length !== proposed.evidence.length) return askAnswer(question, 'unverified_evidence')
  const cited = evidence.map((entry) => allowed.get(entry.sourceId)!)
  if (question.options?.length && !question.options.includes(proposed.answer)) return askAnswer(question, 'answer_does_not_match_field')
  const answer = validExplicitAnswer(question, proposed.answer)
  if (!answer || (question.type === 'number' && !/^-?\d+(?:\.\d+)?$/.test(answer))) return askAnswer(question, 'answer_does_not_match_field')
  if (proposed.missingInfo.length) return askAnswer(question, 'missing_fact', proposed.missingInfo)
  const professional = topic === 'professional' || topic === 'contact'
  if (!professional && cited.some((source) => source.kind !== 'explicit_answer')) return askAnswer(question, 'sensitive_answer_requires_user_fact')
  if (topic === 'sponsorship' || topic === 'work_authorization') {
    const country = countryForQuestion(question)
    if (!country) return askAnswer(question, 'country_context_missing', ['Which country does this application’s work-authorisation question refer to?'])
    const polarity = binary(answer)
    if (polarity) {
      if (!cited.some((source) => conditionalCountryAnswer(source, country) === polarity)) return askAnswer(question, 'country_answer_not_explicit')
    } else if (!cited.some((source) => countriesIn(source.text).includes(country) && normalized(source.text).includes(normalized(answer)))) return askAnswer(question, 'country_answer_not_explicit')
  }
  if (topic.startsWith('salary') && !cited.every((source) => salaryContextMatches(question, source))) return askAnswer(question, 'salary_currency_or_period_missing')
  const subjective = /\b(?:why|motivat\w*|cover\s*letter|describe|tell\s+us|example|a time|personal story)\b/i.test(question.label)
  if (proposed.decision === 'draft' || subjective) {
    if (!professional || cited.some((source) => source.topic !== 'professional')) return askAnswer(question, 'sensitive_drafting_forbidden')
    if (/\b(?:a time|personal story|conflict|disagree|failure|biggest challenge)\b/i.test(question.label) && !cited.some((source) => /\b(?:conflict|disagree|failure|challenge)\b/i.test(source.text))) return askAnswer(question, 'personal_example_missing', ['Describe a specific example from your own experience.'])
    // Extractive drafting: the model selects useful saved facts, but cannot add
    // an unsupported achievement, passion, event, or promise between the quotes.
    const draft = evidence.map((entry) => entry.quote.trim()).join(' ').trim()
    if (draft.split(/\s+/).length > 60 || !draft) return askAnswer(question, 'draft_not_bounded')
    return { ...proposed, answer: draft, decision: 'draft', confidence: Math.min(proposed.confidence, 1), evidence, reason: 'Draft assembled only from verified profile/resume quotations.', missingInfo: [], autoApply: true }
  }
  if (proposed.confidence < 0.95) return askAnswer(question, 'low_confidence', proposed.missingInfo)
  const direct = evidence.some((entry) => {
    if (/^-?\d+(?:\.\d+)?$/.test(answer)) {
      const escaped = answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(^|[^0-9.])${escaped}([^0-9.]|$)`).test(entry.quote)
    }
    return normalized(entry.quote).includes(normalized(answer))
  })
  if (professional && /\b(?:years?|how long)\b/i.test(question.label) && /\b(?:with|using|in\s+\w+|working on)\b/i.test(question.label) && cited.every((source) => /total.*experience|years.*professional/i.test(source.label))) return askAnswer(question, 'skill_specific_experience_missing')
  const conditional = (topic === 'sponsorship' || topic === 'work_authorization') && Boolean(binary(answer))
  if (!direct && !conditional) return askAnswer(question, 'answer_not_present_in_evidence')
  return { ...proposed, answer, evidence, reason: 'Matched saved evidence with field and context checks.', missingInfo: [], autoApply: true }
}


/** Historical opt-outs stay private to their application until the owner opts in. */
export function canUsePriorHumanAnswer(answer: { applicationId: string; remember: boolean; answerMeta?: unknown }, currentApplicationIds: ReadonlySet<string>): boolean {
  const meta = answer.answerMeta as { source?: string } | null | undefined
  if (meta?.source && meta.source !== 'user' && meta.source !== 'explicit_user') return false
  return answer.remember || currentApplicationIds.has(answer.applicationId)
}
