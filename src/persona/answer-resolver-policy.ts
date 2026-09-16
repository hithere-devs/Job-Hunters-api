import { credentialFieldReason, sensitiveReason, validExplicitAnswer, type FormField } from '../hunt/apply/fields.js'

export type AnswerTopic = 'professional' | 'contact' | 'salary_current' | 'salary_expected' | 'sponsorship' | 'work_authorization' | 'gender' | 'pronouns' | 'ethnicity' | 'disability' | 'veteran' | 'legal' | 'credential'
export interface AnswerSource { id: string; label: string; text: string; kind: 'profile' | 'resume' | 'explicit_answer'; topic: AnswerTopic; applicationId?: string; country?: string | null }
export interface ResolverQuestion extends FormField { id: string; applicationId: string; role: string; company: string; location: string | null }
export interface AnswerEvidence { sourceId: string; quote: string }
export interface ResolvedApplicationAnswer { questionId: string; decision: 'known' | 'draft' | 'ask'; answer: string | null; confidence: number; evidence: AnswerEvidence[]; reason: string; missingInfo: string[]; autoApply: boolean }
export type ProposedAnswer = Omit<ResolvedApplicationAnswer, 'autoApply'>

export const INFERRED_ANSWER_REASON = 'inferred_from_saved_profile'
export const DEFAULT_ANSWER_REASON = 'user_authorized_safe_default'

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

function booleanFieldAnswer(question: ResolverQuestion, yes: boolean): string | null {
  if (!question.options?.length) return question.type === 'checkbox' ? String(yes) : yes ? 'Yes' : 'No'
  const pattern = yes ? /^\s*(?:yes|true)\b/i : /^\s*(?:no|false|decline|prefer\s+not)\b/i
  return question.options.find(option => pattern.test(option)) ?? null
}

/**
 * Bounded fallbacks for applications that must keep moving when the model is
 * unavailable. They either reuse an explicit fact, summarize supplied work
 * history, or choose a privacy-preserving preference. They never fabricate a
 * credential, protected trait, criminal-history answer, or legal attestation.
 */
export function inferApplicationAnswer(question: ResolverQuestion, sources: AnswerSource[], includeProfessionalDraft = false): ResolvedApplicationAnswer | null {
  const topic = answerTopic(question)
  if (topic === 'credential' || topic === 'legal') return null

  if (topic === 'sponsorship' || topic === 'work_authorization') {
    const country = countryForQuestion(question)
    if (!country) return null
    const matches = sources
      .filter(source => source.kind === 'explicit_answer' && source.topic === topic)
      .map(source => ({ source, value: conditionalCountryAnswer(source, country) }))
      .filter((entry): entry is { source: AnswerSource; value: 'yes' | 'no' } => entry.value !== null)
    const values = new Set(matches.map(entry => entry.value))
    if (values.size !== 1) return null
    const value = [...values][0]!
    const answer = booleanFieldAnswer(question, value === 'yes')
    if (!answer) return null
    const source = matches.find(entry => entry.value === value)!.source
    return { questionId: question.id, decision: 'known', answer, confidence: 1, evidence: [{ sourceId: source.id, quote: source.text }], reason: INFERRED_ANSWER_REASON, missingInfo: [], autoApply: true }
  }

  if (/\b(?:sms|text messages?|whats ?app|marketing|job alerts?|career updates?)\b/i.test(question.label)) {
    const answer = booleanFieldAnswer(question, false)
    if (answer) return { questionId: question.id, decision: 'known', answer, confidence: 1, evidence: [], reason: DEFAULT_ANSWER_REASON, missingInfo: [], autoApply: true }
  }

  if (['gender', 'pronouns', 'ethnicity', 'disability', 'veteran'].includes(topic)) {
    const answer = question.options?.find(option => /prefer\s+not|decline\s+to|do not wish/i.test(option)) ?? null
    if (answer) return { questionId: question.id, decision: 'known', answer, confidence: 1, evidence: [], reason: DEFAULT_ANSWER_REASON, missingInfo: [], autoApply: true }
    return null
  }

  if (topic === 'salary_expected') {
    const answer = question.options?.find(option => /negotiable|open to discussion|prefer not/i.test(option))
      ?? (['text', 'textarea'].includes(question.type) ? 'Open to discussion based on the role scope and total compensation.' : null)
    if (answer) return { questionId: question.id, decision: 'known', answer, confidence: 0.8, evidence: [], reason: DEFAULT_ANSWER_REASON, missingInfo: [], autoApply: true }
    return null
  }

  if (topic === 'contact' && /\bgithub\b/i.test(question.label) && ['text', 'url'].includes(question.type) && question.required) {
    return { questionId: question.id, decision: 'known', answer: 'Not provided', confidence: 1, evidence: [], reason: DEFAULT_ANSWER_REASON, missingInfo: [], autoApply: true }
  }

  const priorEmployer = /\b(?:ever|previously)\s+(?:worked|employed)|\bworked\s+(?:for|at)\b/i.test(question.label)
  if (priorEmployer && question.company.trim()) {
    const employment = sources.filter(source => source.kind !== 'explicit_answer' && /professional experience/i.test(source.label))
    if (!employment.length) return null
    const company = question.company.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const workedThere = employment.some(source => source.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').includes(company))
    const answer = booleanFieldAnswer(question, workedThere)
    if (!answer) return null
    return { questionId: question.id, decision: 'known', answer, confidence: 0.9, evidence: employment.slice(0, 5).map(source => ({ sourceId: source.id, quote: source.text })), reason: INFERRED_ANSWER_REASON, missingInfo: [], autoApply: true }
  }

  if (includeProfessionalDraft && topic === 'professional' && /\b(?:why|motivat\w*|describe|tell\s+us|experience|built|architected|shipped|handled|challenges?)\b/i.test(question.label)) {
    const candidates = sourcesForQuestion(question, sources).filter(source => source.topic === 'professional')
    const evidence: AnswerEvidence[] = []
    let words = 0
    for (const source of candidates) {
      const quote = source.text.trim()
      const count = quote.split(/\s+/).length
      if (!quote || words + count > 60) continue
      evidence.push({ sourceId: source.id, quote })
      words += count
      if (words >= 35) break
    }
    if (evidence.length) return { questionId: question.id, decision: 'draft', answer: evidence.map(item => item.quote).join(' '), confidence: 0.8, evidence, reason: INFERRED_ANSWER_REASON, missingInfo: [], autoApply: true }
  }

  if (includeProfessionalDraft && topic === 'professional' && /\bopen\s*source\b/i.test(question.label)) {
    return { questionId: question.id, decision: 'draft', answer: 'I do not have a specific public open-source contribution to highlight.', confidence: 0.8, evidence: [], reason: DEFAULT_ANSWER_REASON, missingInfo: [], autoApply: true }
  }
  return null
}

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
      // A reply about why the applicant wants company A is not evidence of
      // wanting company B. Recompose from resume facts instead.
      if (source.kind === 'explicit_answer' && source.applicationId && source.applicationId !== question.applicationId && /why.*(?:our|this|join|work here|company|we.*hire)|cover\s*letter|motivat.*(?:company|role|position)/i.test(source.label)) return false
      const essay = /\b(?:why|motivat\w*|cover\s*letter|describe|tell\s+us|example|a time|personal story)\b/i.test(question.label)
      return source.topic === 'professional' || (!essay && source.topic === 'contact')
    }
    // Work authorisation and sponsorship are asked as one another's inverse and
    // are answered from the same facts, so a residence or stated-authorisation
    // fact serves both. Profile-kind facts are visible here only for those two
    // topics; everything else still requires the user's own prior answer.
    // A residence fact informs both questions, so profile-kind facts are visible
    // across the work-rights family. A prior *answer* is not: "I need
    // sponsorship in the USA" and "I am authorized to work in the USA" are
    // different claims — someone on a student visa is both — so explicit
    // answers stay topic-exact.
    const workRights = topic === 'sponsorship' || topic === 'work_authorization'
    if (workRights && source.kind === 'profile') {
      return source.topic === 'sponsorship' || source.topic === 'work_authorization'
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
  // Work authorisation may be reasoned from the profile, not only from a prior
  // typed answer.
  //
  // Requiring an `explicit_answer` source meant the resolver could never answer
  // these until the user had already answered them by hand on some earlier
  // posting — so in practice every application stopped on them. Residence plus
  // the job's country is enough to reason with, and the owner asked for that
  // over being asked the same question on every form. Demographics, salary and
  // background questions keep the strict rule.
  const derivable = topic === 'sponsorship' || topic === 'work_authorization'
  if (!professional && !derivable && cited.some((source) => source.kind !== 'explicit_answer')) return askAnswer(question, 'sensitive_answer_requires_user_fact')
  if (topic === 'sponsorship' || topic === 'work_authorization') {
    const country = countryForQuestion(question)
    if (!country) return askAnswer(question, 'country_context_missing', ['Which country does this application’s work-authorisation question refer to?'])
    const polarity = binary(answer)
    // An explicit country-specific statement is still the strongest evidence
    // and is accepted outright. Failing that, a residence or stated-authorisation
    // fact from the profile is enough for the model to reason from — which is
    // the whole point of citing it.
    const statedForCountry = cited.some((source) => conditionalCountryAnswer(source, country) === polarity)
    const profileFact = cited.some((source) => source.topic === 'work_authorization' && source.kind === 'profile')
    if (polarity) {
      if (!statedForCountry && !profileFact) return askAnswer(question, 'country_answer_not_explicit')
    } else if (!cited.some((source) => countriesIn(source.text).includes(country) && normalized(source.text).includes(normalized(answer))) && !profileFact) return askAnswer(question, 'country_answer_not_explicit')
  }
  if (topic.startsWith('salary') && !cited.every((source) => salaryContextMatches(question, source))) return askAnswer(question, 'salary_currency_or_period_missing')
  const subjective = /\b(?:why|motivat\w*|cover\s*letter|describe|tell\s+us|example|a time|personal story)\b/i.test(question.label)
  if (proposed.decision === 'draft' || subjective) {
    if (!professional || cited.some((source) => source.topic !== 'professional')) return askAnswer(question, 'sensitive_drafting_forbidden')
    if (/\b(?:a time|personal story|conflict|disagree|failure|biggest challenge)\b/i.test(question.label) && !cited.some((source) => /\b(?:conflict|disagree|failure|challenge)\b/i.test(source.text))) return askAnswer(question, 'personal_example_missing', ['Describe a specific example from your own experience.'])
    const draft = proposed.answer.trim()
    if (draft.split(/\s+/).length > 120 || !draft) return askAnswer(question, 'draft_not_bounded')
    return { ...proposed, answer: draft, decision: 'draft', confidence: Math.min(proposed.confidence, 1), evidence, reason: 'Drafted from cited profile and resume facts.', missingInfo: [], autoApply: true }
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
