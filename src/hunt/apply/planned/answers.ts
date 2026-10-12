import { sensitiveReason } from '../fields.js'
import { classifyAuthorisationQuestion, countryCodeFor, countryNamedIn } from '../work-authorisation.js'
import { foldLabel } from './schema/fingerprint.js'
import type { FieldKind, FieldOption, SchemaField } from './schema/types.js'

/**
 * Answers are decided before the browser opens, from the form's own schema.
 *
 * Deterministic first (the Kit, the résumé file, explicit consents, work rights
 * that follow from explicit Kit facts), then one model call for the rest, then
 * strict validation of whatever the model returned against the ATS's exact
 * options. A required question nobody can answer safely becomes a question for
 * the user *before* an application starts, not a half-filled form submitted.
 */

export type AnswerAction = 'fill' | 'upload_resume' | 'skip' | 'ask'
export type AnswerBasis = 'kit' | 'resume' | 'saved_answer' | 'derived' | 'policy' | 'model'

export interface PlannedAnswer {
  key: string
  label: string
  kind: FieldKind
  required: boolean
  action: AnswerAction
  /** One value for scalar fields, several for multi-selects. Exact option labels for choices. */
  values: string[]
  basis: AnswerBasis
  confidence: number
  sensitive: boolean
  reason?: string
}

export interface CandidateDossier {
  fullName: string
  firstName: string
  lastName: string
  email: string
  phone: string
  headline: string
  location: { line1: string; line2: string; city: string; region: string; postalCode: string; country: string; countryCode: string | null }
  links: { linkedin: string; github: string; portfolio: string }
  totalExperience: string
  currentCompany: string
  currentTitle: string
  noticePeriod: string
  currentCtc: string
  expectedCtc: string
  workMode: string
  relocate: string
  workAuthorization: string
  visaSponsorship: string
  boundByAgreements: string
  /** Explicit Kit values only. Empty means the user has not said. */
  eeo: { gender: string; sexualOrientation: string; ethnicity: string; veteran: string; disability: string }
  experience: Array<{ role: string; company: string; startedOn: string | null; endedOn: string | null; current: boolean; description: string }>
  education: string
  skills: string[]
  resumeText: string
  /** The user's own earlier answers to application questions, newest first. */
  savedAnswers: Array<{ question: string; answer: string; options: string[] }>
}

export interface JobContext {
  title: string
  company: string
  location: string
  /** ISO-3166 alpha-2 codes of the posting's locations. */
  countries: string[]
  remote: boolean
  description: string
}

/* ------------------------------------------------------------ option matching */

const DECLINE = /decline|prefer not|don['’]?t wish|do not wish|not wish to|choose not|rather not|not to (?:answer|disclose|say|self-identify)|i don['’]?t want to answer|no answer/i
const YES = /^\s*(?:yes|y|true|i agree|agree|i accept|i acknowledge|i confirm|i consent)\b/i
const NO = /^\s*(?:no|n|false)\b/i

function fold(value: string): string {
  return foldLabel(value).replace(/[^a-z0-9+]+/g, ' ').trim()
}

/** Best option for any of the wanted strings, or null. Never guesses below a clear match. */
export function matchOption(options: FieldOption[], wanted: string[]): FieldOption | null {
  let best: { option: FieldOption; score: number } | null = null
  for (const option of options) {
    const hay = fold(option.label)
    const value = fold(option.value ?? '')
    for (const raw of wanted) {
      const needle = fold(raw)
      if (!needle) continue
      let score = 0
      if (hay === needle || value === needle) score = 100
      else if (hay.startsWith(`${needle} `) || hay.startsWith(`${needle},`)) score = 85
      else if (needle.length >= 4 && (` ${hay} `).includes(` ${needle} `)) score = 75
      else if (hay.length >= 4 && (` ${needle} `).includes(` ${hay} `)) score = 70
      else {
        const tokens = needle.split(' ').filter((token) => token.length > 2)
        const hits = tokens.filter((token) => (` ${hay} `).includes(` ${token} `)).length
        if (tokens.length && hits === tokens.length) score = 60
      }
      if (!best || score > best.score) best = { option, score }
    }
  }
  return best && best.score >= 60 ? best.option : null
}

export function declineOption(options: FieldOption[]): FieldOption | null {
  return options.find((option) => DECLINE.test(option.label)) ?? null
}

export function yesNoOption(options: FieldOption[], answer: boolean): FieldOption | null {
  return options.find((option) => (answer ? YES : NO).test(option.label)) ?? null
}

/* ----------------------------------------------------------------- semantics */

export type Semantic =
  | 'first_name' | 'last_name' | 'full_name' | 'preferred_name' | 'email' | 'phone'
  | 'linkedin' | 'github' | 'portfolio' | 'twitter'
  | 'location' | 'country' | 'city' | 'region' | 'postal' | 'address1' | 'address2'
  | 'current_company' | 'current_title' | 'years_experience' | 'notice_period'
  | 'current_salary' | 'expected_salary'
  | 'resume' | 'cover_letter'
  | 'eeo_gender' | 'eeo_orientation' | 'eeo_race' | 'eeo_hispanic' | 'eeo_veteran' | 'eeo_disability' | 'eeo_transgender'
  | 'consent_ack' | 'marketing_consent'
  | 'work_auth' | 'sponsorship' | 'noncompete'
  | 'referral_source' | 'previous_employee' | 'work_auth_countries'
  | 'contact_preference' | 'contact_employer' | 'start_date' | 'office_commitment' | 'languages' | 'conditional_followup' | 'pronouns'

const BY_ATS_NAME: Record<string, Semantic> = {
  first_name: 'first_name', last_name: 'last_name', preferred_name: 'preferred_name', email: 'email', phone: 'phone',
  resume: 'resume', cover_letter: 'cover_letter', gender: 'eeo_gender', race: 'eeo_race', hispanic_ethnicity: 'eeo_hispanic',
  veteran_status: 'eeo_veteran', disability_status: 'eeo_disability',
  _systemfield_name: 'full_name', _systemfield_email: 'email', _systemfield_resume: 'resume', _systemfield_phone: 'phone',
  _systemfield_location: 'location',
}

export function semanticOf(field: SchemaField): Semantic | null {
  if (field.atsName && BY_ATS_NAME[field.atsName]) return BY_ATS_NAME[field.atsName]!
  if (field.kind === 'file') return field.fileRole === 'cover_letter' ? 'cover_letter' : field.fileRole === 'resume' ? 'resume' : null
  const label = foldLabel(field.label)
  const short = label.length <= 60
  if (field.section === 'eeo' || /\b(?:gender|sexual orientation|race|ethnicit|hispanic|latino|veteran|disabilit|transgender)/.test(label)) {
    if (/transgender/.test(label)) return 'eeo_transgender'
    if (/sexual orientation|orientation/.test(label)) return 'eeo_orientation'
    if (/hispanic|latino/.test(label) && !/race/.test(label)) return 'eeo_hispanic'
    if (/race|ethnicit/.test(label)) return 'eeo_race'
    if (/veteran/.test(label)) return 'eeo_veteran'
    if (/disabilit/.test(label)) return 'eeo_disability'
    if (/gender|^sex$/.test(label)) return 'eeo_gender'
  }
  if (/^(?:what are )?(?:your )?(?:preferred )?pronouns\??$/.test(label)) return 'pronouns'
  if (/\b(?:sms|text message|whatsapp|marketing|newsletter|promotional|future (?:job )?opportunit|talent (?:community|network|pool))|opt[- ]?in to receive/.test(label)) return 'marketing_consent'
  if (/^if (?:you )?(?:selected|answered|chose|checked|picked)\b|^if (?:yes|so|other|applicable)\b/.test(label) && (field.kind === 'text' || field.kind === 'textarea')) return 'conditional_followup'
  if (/how (?:should|would you like|do you prefer|can|may) (?:we|us) (?:to )?(?:communicate|contact|reach)|preferred (?:method of |mode of )?(?:communication|contact)/.test(label)) return 'contact_preference'
  if (/(?:may|can) we contact your (?:current |present )?employer|(?:ok|okay) to contact your (?:current |present )?employer/.test(label)) return 'contact_employer'
  if (/when (?:can|could|would) you (?:start|join|begin)|earliest (?:possible )?(?:start|joining) date|available to (?:start|join)|availability to (?:start|join)|^(?:desired |expected |preferred )?start date/.test(label)) return 'start_date'
  if (/languages? (?:do )?you speak|speak fluently|languages? (?:in which )?you (?:are|have) (?:business[- ]level )?fluen/.test(label)) return 'languages'
  if (/\b(?:hybrid|in[- ]office|on[- ]?site|in the office|in our .{0,40}office)\b.{0,240}\b(?:days? (?:a|per|each) week|office)\b/.test(label) && (field.kind === 'select' || field.kind === 'boolean' || field.kind === 'checkbox')) return 'office_commitment'
  if (field.section === 'consent' || /^(?:by (?:checking|selecting|clicking|submitting)|i (?:agree|acknowledge|confirm|certify|consent|have read|understand))|arbitration|privacy (?:policy|notice)|ai policy|applicant (?:privacy|data)|terms (?:and|&) conditions|certify that|please (?:double-?)?check (?:all )?(?:the )?information|information (?:provided|i have provided) (?:is|above is) (?:true|accurate|complete)/.test(label)) return 'consent_ack'
  if (/\b(?:how|where) (?:did|have) you (?:first )?(?:hear|heard|learn|learned|learnt|find out|found out) about|how did you (?:first )?(?:come across|find) (?:this|us|the)|referral source|source of (?:application|referral)/.test(label)) return 'referral_source'
  if (/\b(?:have you|did you) (?:ever |previously )?(?:been )?(?:employed|worked|interned|contracted|interviewed)\b.{0,40}\b(?:at|for|with|before)\b|\bpreviously (?:been )?(?:employed|worked) (?:at|for|by)\b|\b(?:are you a |a )?(?:former|current|previous) (?:employee|intern|contractor)\b/.test(label)) return 'previous_employee'
  if (/\b(?:in )?(?:what|which) countr(?:y|ies)\b.{0,60}\b(?:right to work|authori[sz]ed to work|work authori[sz]ation|permitted to work|legally (?:work|able))/.test(label)) return 'work_auth_countries'
  const auth = classifyAuthorisationQuestion(field.label)
  if (auth === 'sponsorship') return 'sponsorship'
  if (auth === 'authorised') return 'work_auth'
  if (/restrictive covenant|non-?compete|non-?solicit|post-employment restriction|employment agreements?|bound by any agreement|agreements? with (?:a |your )?(?:current|former|previous)/.test(label)) return 'noncompete'
  if (short) {
    if (/^(?:legal )?first name|^given name/.test(label)) return 'first_name'
    if (/^(?:legal )?last name|^surname|^family name/.test(label)) return 'last_name'
    if (/preferred (?:first )?name|name you(?:'|’)?d prefer|nickname/.test(label)) return 'preferred_name'
    if (/^(?:full |legal |your )?name$|^full legal name|^applicant name/.test(label)) return 'full_name'
    if (/\be-?mail\b/.test(label)) return 'email'
    if (/\b(?:phone|mobile|cell)\b/.test(label) && !/country code/.test(label)) return 'phone'
    if (/linkedin/.test(label)) return 'linkedin'
    if (/github/.test(label)) return 'github'
    if (/twitter|^x$|x \(twitter\)/.test(label)) return 'twitter'
    if (/portfolio|personal (?:web)?site|^website|homepage/.test(label)) return 'portfolio'
    if (/^(?:current )?country(?: of residence)?$|country (?:of|where you) (?:residence|reside|live)|what is your current country/.test(label)) return 'country'
    if (/^(?:current )?city$/.test(label)) return 'city'
    if (/^(?:state|province|region)(?:\/province)?$/.test(label)) return 'region'
    if (/postal|zip/.test(label)) return 'postal'
    if (/address line 1|^street|^address$/.test(label)) return 'address1'
    if (/address line 2/.test(label)) return 'address2'
    if (/location \(city\)|^location$|current location|where are you (?:currently )?(?:based|located)|where do you (?:currently )?(?:live|reside)/.test(label)) return 'location'
    if (/current (?:company|employer)|^company$|most recent (?:company|employer)/.test(label)) return 'current_company'
  }
  if (!short && /name of your current(?: \(or most recent\)| or most recent)? (?:company|employer)|current \(or most recent\) (?:company|employer)/.test(label)) return 'current_company'
  if (short) {
    if (/current (?:job )?title|current role|^title$|most recent (?:job )?title/.test(label)) return 'current_title'
    if (/years of (?:professional |relevant )?experience|total experience/.test(label)) return 'years_experience'
    if (/notice period/.test(label)) return 'notice_period'
  }
  if (/how (?:many|long) (?:days |weeks |months )?(?:is )?your notice period|notice period \(in (?:days|weeks|months)\)/.test(label)) return 'notice_period'
  if (/current (?:salary|ctc|compensation)|what(?:'|’)?s your current salary/.test(label)) return 'current_salary'
  if (/(?:expected|desired) (?:salary|ctc|compensation)|salary expectation|compensation expectation/.test(label)) return 'expected_salary'
  if (field.kind === 'location') return 'location'
  return null
}

/* ------------------------------------------------------------- deterministic */

function answer(field: SchemaField, action: AnswerAction, values: string[], basis: AnswerBasis, reason: string, confidence = 1): PlannedAnswer {
  return {
    key: field.key,
    label: field.label,
    kind: field.kind,
    required: field.required,
    action,
    values,
    basis,
    confidence,
    sensitive: Boolean(sensitiveReason(field.label, field.options.map((option) => option.label))) || field.section === 'eeo',
    reason,
  }
}

function missing(field: SchemaField, what: string): PlannedAnswer {
  return field.required
    ? answer(field, 'ask', [], 'policy', `${what} is not in My Kit.`, 0)
    : answer(field, 'skip', [], 'policy', `Optional, and ${what} is not in My Kit.`)
}

/**
 * An annual amount in the unit the question asks for. "Current salary (in
 * lakhs per annum)" wants 48, not 4,800,000; a number input wants bare digits.
 * The Kit value is read as written ("4800000", "48,00,000", "48 LPA", "$120k").
 */
export function compensationIn(label: string, kind: SchemaField['kind'], raw: string): string {
  const text = raw.trim()
  const match = /(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|lpa|l\b|crores?|cr\b|k\b|thousand|m\b|mn\b|million)?/i.exec(text)
  if (!match) return text
  const scale: Record<string, number> = { lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, lpa: 1e5, l: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6 }
  const amount = Number(match[1]!.replace(/,/g, '')) * (scale[(match[2] ?? '').toLowerCase()] ?? 1)
  if (!Number.isFinite(amount) || amount <= 0) return text
  const asked = label.toLowerCase()
  const unit = /lakh|\blacs?\b|\blpa\b/.test(asked) ? 1e5 : /crore/.test(asked) ? 1e7 : /in thousands|\(k\)|in k\b/.test(asked) ? 1e3 : /in millions/.test(asked) ? 1e6 : 1
  if (unit === 1 && kind !== 'number' && !match[2]) return text
  const value = amount / unit
  return String(Number.isInteger(value) ? value : Number(value.toFixed(2)))
}

/** "30 days" / "1 month" / "Immediate", in the unit a numeric question asks for. */
export function noticeIn(label: string, kind: SchemaField['kind'], raw: string): string {
  const text = raw.trim()
  const asked = label.toLowerCase()
  const wantsNumber = kind === 'number' || /how many (?:days|weeks|months)|\(in (?:days|weeks|months)\)|in (?:days|weeks|months)\b/.test(asked)
  if (!wantsNumber) return text
  let days: number | null = null
  if (/immediate|^0\b|none|serving/i.test(text)) days = 0
  const match = /(\d+(?:\.\d+)?)\s*(days?|d\b|weeks?|w\b|months?|m\b)?/i.exec(text)
  if (days === null && match) {
    const unit = (match[2] ?? 'days').toLowerCase()
    days = Number(match[1]) * (unit.startsWith('w') ? 7 : unit.startsWith('m') ? 30 : 1)
  }
  if (days === null) return text
  const per = /weeks/.test(asked) ? 7 : /months/.test(asked) ? 30 : 1
  const value = days / per
  return String(Number.isInteger(value) ? value : Number(value.toFixed(1)))
}

/** Text or a matching option, depending on the control. */
function fillWith(field: SchemaField, value: string, basis: AnswerBasis, reason: string, aliases: string[] = []): PlannedAnswer | null {
  if (!value.trim()) return null
  // A dropdown whose options load only when opened: type the value; the
  // executor picks the live option and verifies it committed.
  if ((field.kind === 'select' || field.kind === 'multiselect') && !field.options.length) return answer(field, 'fill', [value.trim()], basis, reason, 0.9)
  if (field.kind === 'select' || field.kind === 'multiselect' || field.kind === 'boolean') {
    const option = matchOption(field.options, [value, ...aliases])
    return option ? answer(field, 'fill', [option.label], basis, reason) : null
  }
  return answer(field, 'fill', [value.trim()], basis, reason)
}

/**
 * "I am authorized to work for any employer…" / "I require/will require
 * sponsorship…": options that state the situation instead of yes/no.
 */
function workRightsOption(field: SchemaField, needsSponsorship: boolean, reason: string): PlannedAnswer | null {
  const sponsorNeeded = (label: string) => /\b(?:require|need|requires|needs)\b[^.]{0,60}sponsor/i.test(label) && !/\b(?:not|no|don['’]t|do not|does not|without)\b[^.]{0,20}(?:require|need)/i.test(label)
  const authorised = (label: string) => !sponsorNeeded(label) && /authori[sz]ed to work|(?:do not|don['’]t|will not|won['’]t) (?:now or in the future )?(?:require|need)|no sponsorship|without (?:requiring |needing )?sponsorship|citizen|permanent resident/i.test(label)
  const matches = field.options.filter((option) => needsSponsorship ? sponsorNeeded(option.label) : authorised(option.label))
  return matches.length === 1 ? answer(field, 'fill', [matches[0]!.label], 'derived', reason) : null
}

function isChoice(field: SchemaField): boolean {
  return field.kind === 'select' || field.kind === 'multiselect' || field.kind === 'boolean'
}

function chooseYesNo(field: SchemaField, yes: boolean, basis: AnswerBasis, reason: string): PlannedAnswer | null {
  if (field.kind === 'checkbox') return answer(field, 'fill', [yes ? 'true' : 'false'], basis, reason)
  if (field.kind === 'text' || field.kind === 'textarea') return answer(field, 'fill', [yes ? 'Yes' : 'No'], basis, reason)
  // Options that load only when opened: type it; the executor verifies the pick.
  if ((field.kind === 'select' || field.kind === 'boolean') && !field.options.length) return answer(field, 'fill', [yes ? 'Yes' : 'No'], basis, reason, 0.9)
  // "Yes, EU Blue Card" and "Yes, but not one of the visas listed here" both
  // say yes and mean different things: leave the choice to the planner.
  const candidates = field.options.filter((option) => (yes ? YES : NO).test(option.label))
  if (candidates.length === 1) return answer(field, 'fill', [candidates[0]!.label], basis, reason)
  // Several ways of saying yes: only a generic one is truthful without
  // claiming a specific visa or status the facts do not establish.
  const generic = candidates.filter((option) => /^\s*(?:yes|no)\s*\.?\s*$/i.test(option.label) || /\b(?:not (?:one of )?(?:the )?(?:visas? |options? )?listed|none of (?:the )?(?:above|listed)|other(?:wise)?|another (?:visa|type))\b/i.test(option.label))
  return generic.length === 1 ? answer(field, 'fill', [generic[0]!.label], basis, reason) : null
}

/** EEO: the user's explicit Kit value, else an explicit decline, else skip/ask. Never invented. */
function eeo(field: SchemaField, kitValue: string, aliases: string[] = []): PlannedAnswer {
  if (kitValue.trim()) {
    const picked = field.kind === 'text' || field.kind === 'textarea'
      ? kitValue.trim()
      : matchOption(field.options, [kitValue, ...aliases])?.label
    if (picked) return answer(field, 'fill', [picked], 'kit', 'Your explicit My Kit answer.')
  }
  const decline = declineOption(field.options)
  if (decline) return answer(field, 'fill', [decline.label], 'policy', kitValue ? 'Your Kit answer is not offered here; declining to self-identify.' : 'Not set in My Kit; declining to self-identify.')
  return field.required
    ? answer(field, 'ask', [], 'policy', 'A required demographic question with no decline option and no Kit answer.', 0)
    : answer(field, 'skip', [], 'policy', 'Optional demographic question; not set in My Kit.')
}

const NOT_REQUIRED = /\b(?:not required|no(?:t)? (?:need|require)|don['’]?t need|do not need|never)\b/i
const REQUIRED_OUTSIDE = /\brequired\b|\bneed(?:s|ed)?\b/i

/**
 * Work rights that follow from explicit Kit facts. Residence alone decides
 * nothing: without a stated sponsorship need, the question goes to the model
 * with the user's saved answers, and from there to the user if still unclear.
 */
export function deriveWorkRights(field: SchemaField, dossier: CandidateDossier, job: JobContext): { kind: 'work_auth' | 'sponsorship'; yes: boolean; reason: string } | null {
  const kind = classifyAuthorisationQuestion(field.label) === 'sponsorship' ? 'sponsorship' : 'work_auth'
  const home = dossier.location.countryCode
  const named = countryNamedIn(`${field.label} ${field.description ?? ''}`)
  const aboutResidence = /\bcountry (?:where|in which) you (?:currently )?(?:live|reside)\b|\bcountry of (?:your )?residence\b|\bwhere you (?:currently )?(?:live|reside)\b/i.test(field.label)
  const fromLocation = countryNamedIn(job.location)
  const listed = [...new Set(job.countries.length ? job.countries : fromLocation ? [fromLocation] : [])]
  if (!home) return null
  // One jurisdiction when the question names it, asks about residence, or every
  // location the job lists falls on the same side of "home vs abroad".
  const aboutDesired = job.remote && !listed.length && /\b(?:your )?desired (?:work )?location\b|where you (?:want|would like|plan|intend) to work/i.test(field.label)
  const jurisdiction = named ?? (aboutResidence || aboutDesired ? home
    : listed.length && listed.every((code) => code === home) ? home
      : listed.length && listed.every((code) => code !== home) ? listed[0]!
        : null)
  if (!jurisdiction) return null
  const sponsorshipText = dossier.visaSponsorship.trim()
  const authorised = authorisedCountries(dossier.workAuthorization, home)
  const authorisedAtHome = !/^\s*(?:no|false|not authori[sz]ed)\b/i.test(dossier.workAuthorization)
  if (jurisdiction === home) {
    if (!authorisedAtHome) return null
    return kind === 'sponsorship'
      ? { kind, yes: false, reason: `The role is in your country (${home}); no sponsorship needed.` }
      : { kind, yes: true, reason: `The role is in your country (${home}).` }
  }
  // My Kit names the countries where the user may work now ("India, USA").
  // Authorisation follows from that list; sponsorship still follows from the
  // stated sponsorship need ("now or in the future").
  if (kind === 'work_auth' && authorised.includes(jurisdiction)) {
    return { kind, yes: true, reason: `My Kit lists ${jurisdiction} among the countries you are authorised to work in.` }
  }
  if (!sponsorshipText) return null
  if (NOT_REQUIRED.test(sponsorshipText)) {
    return kind === 'sponsorship'
      ? { kind, yes: false, reason: `My Kit says sponsorship is not required ("${sponsorshipText}").` }
      : { kind, yes: true, reason: `My Kit says sponsorship is not required ("${sponsorshipText}").` }
  }
  const exceptions = (sponsorshipText.match(/outside ([a-z ,]+)/i)?.[1] ?? '').split(/,|\band\b/).map((part) => countryCodeFor(part.trim())).filter(Boolean)
  if (REQUIRED_OUTSIDE.test(sponsorshipText) && !exceptions.includes(jurisdiction)) {
    return kind === 'sponsorship'
      ? { kind, yes: true, reason: `My Kit: "${sponsorshipText}"; the role is in ${jurisdiction}.` }
      : { kind, yes: false, reason: `My Kit: "${sponsorshipText}"; the role is in ${jurisdiction}.` }
  }
  return null
}

/** Countries named in My Kit's work-authorisation field; a bare yes means home. */
export function authorisedCountries(text: string, home: string | null): string[] {
  const value = text.trim()
  if (!value) return []
  if (/^\s*(?:yes|true|authori[sz]ed)\s*$/i.test(value)) return home ? [home] : []
  const codes = value.split(/[,;/&]|\band\b/i).map((part) => countryCodeFor(part.trim())).filter((code): code is string => Boolean(code))
  return [...new Set(codes)]
}

export function deterministicAnswer(field: SchemaField, dossier: CandidateDossier, job: JobContext): PlannedAnswer | null {
  const semantic = semanticOf(field)
  const loc = dossier.location
  switch (semantic) {
    case 'first_name': return dossier.firstName ? answer(field, 'fill', [dossier.firstName], 'kit', 'Name from My Kit.') : missing(field, 'Your first name')
    case 'last_name': return dossier.lastName ? answer(field, 'fill', [dossier.lastName], 'kit', 'Name from My Kit.') : missing(field, 'Your last name')
    case 'full_name': return dossier.fullName ? answer(field, 'fill', [dossier.fullName], 'kit', 'Name from My Kit.') : missing(field, 'Your name')
    case 'preferred_name': return dossier.firstName ? answer(field, 'fill', [dossier.firstName], 'kit', 'First name from My Kit.') : missing(field, 'A preferred name')
    case 'email': return dossier.email ? answer(field, 'fill', [dossier.email], 'kit', 'Application email from My Kit.') : missing(field, 'Your email')
    case 'phone': return dossier.phone ? answer(field, 'fill', [dossier.phone], 'kit', 'Phone from My Kit.') : missing(field, 'Your phone')
    case 'linkedin': return dossier.links.linkedin ? answer(field, 'fill', [dossier.links.linkedin], 'kit', 'LinkedIn from My Kit.') : missing(field, 'A LinkedIn URL')
    case 'github': return dossier.links.github ? answer(field, 'fill', [dossier.links.github], 'kit', 'GitHub from My Kit.') : missing(field, 'A GitHub URL')
    case 'portfolio': return dossier.links.portfolio ? answer(field, 'fill', [dossier.links.portfolio], 'kit', 'Website from My Kit.') : missing(field, 'A portfolio URL')
    case 'twitter': return field.required ? null : answer(field, 'skip', [], 'policy', 'Optional social link.')
    case 'resume': return answer(field, 'upload_resume', [], 'kit', 'Your base résumé.')
    case 'cover_letter': return field.required ? null : answer(field, 'skip', [], 'policy', 'Optional cover letter file.')
    case 'location': {
      if (!loc.city) return missing(field, 'Your city')
      const full = [loc.city, loc.region, loc.country].filter(Boolean).join(', ')
      if (field.kind === 'select') return fillWith(field, full, 'kit', 'Location from My Kit.', [loc.city, loc.country])
      return answer(field, 'fill', [field.kind === 'location' ? loc.city : full], 'kit', 'Location from My Kit.')
    }
    case 'country': {
      if (!loc.country) return missing(field, 'Your country')
      return fillWith(field, loc.country, 'kit', 'Country from My Kit.', [loc.countryCode ?? '', loc.country === 'India' ? 'IN' : ''])
        ?? (field.required ? null : answer(field, 'skip', [], 'policy', 'Country not offered.'))
    }
    case 'city': return loc.city ? fillWith(field, loc.city, 'kit', 'City from My Kit.') : missing(field, 'Your city')
    case 'region': return loc.region ? fillWith(field, loc.region, 'kit', 'Region from My Kit.') : missing(field, 'Your state/region')
    case 'postal': return loc.postalCode ? fillWith(field, loc.postalCode, 'kit', 'Postal code from My Kit.') : missing(field, 'Your postal code')
    case 'address1': return loc.line1 ? fillWith(field, loc.line1, 'kit', 'Address from My Kit.') : missing(field, 'Your street address')
    case 'address2': return loc.line2 ? fillWith(field, loc.line2, 'kit', 'Address from My Kit.') : answer(field, 'skip', [], 'policy', 'No second address line.')
    case 'current_company': return dossier.currentCompany ? fillWith(field, dossier.currentCompany, 'resume', 'Current employer from your résumé.') : null
    case 'current_title': return dossier.currentTitle ? fillWith(field, dossier.currentTitle, 'resume', 'Current title from your résumé.') : null
    case 'years_experience': return field.kind === 'text' || field.kind === 'number' ? (dossier.totalExperience ? answer(field, 'fill', [dossier.totalExperience.replace(/[^\d.]/g, '') || dossier.totalExperience], 'kit', 'Total experience from My Kit.') : null) : null
    case 'notice_period': {
      if (!dossier.noticePeriod) return null
      if (field.kind === 'text') return answer(field, 'fill', [noticeIn(field.label, field.kind, dossier.noticePeriod)], 'kit', 'Notice period from My Kit.')
      if (field.kind === 'number') {
        const value = noticeIn(field.label, field.kind, dossier.noticePeriod)
        return /^\d+(?:\.\d+)?$/.test(value) ? answer(field, 'fill', [value], 'kit', 'Notice period from My Kit.') : null
      }
      return null
    }
    case 'current_salary': return dossier.currentCtc ? fillWith(field, isChoice(field) ? dossier.currentCtc : compensationIn(field.label, field.kind, dossier.currentCtc), 'kit', 'Current compensation from My Kit.') : missing(field, 'Your current compensation')
    case 'expected_salary': return dossier.expectedCtc ? fillWith(field, isChoice(field) ? dossier.expectedCtc : compensationIn(field.label, field.kind, dossier.expectedCtc), 'kit', 'Expected compensation from My Kit.') : missing(field, 'Your expected compensation')
    case 'eeo_gender': return eeo(field, dossier.eeo.gender, /^male$/i.test(dossier.eeo.gender) ? ['Man'] : /^female$/i.test(dossier.eeo.gender) ? ['Woman'] : [])
    case 'eeo_orientation': return eeo(field, dossier.eeo.sexualOrientation, /hetero|straight/i.test(dossier.eeo.sexualOrientation) ? ['Heterosexual', 'Straight'] : [])
    case 'eeo_race': return eeo(field, dossier.eeo.ethnicity, /indian|south asian/i.test(dossier.eeo.ethnicity) ? ['Asian Indian', 'South Asian', 'Asian'] : [])
    case 'eeo_veteran': return eeo(field, dossier.eeo.veteran, /not|no\b/i.test(dossier.eeo.veteran) ? ['I am not a protected veteran', 'Not a veteran', 'No military service'] : [])
    case 'eeo_disability': return eeo(field, dossier.eeo.disability, /^no\b|do not|don['’]t/i.test(dossier.eeo.disability) ? ['No, I do not have a disability', 'No'] : [])
    case 'eeo_hispanic': {
      if (dossier.eeo.ethnicity.trim()) {
        const yes = /hispanic|latin/i.test(dossier.eeo.ethnicity)
        const picked = chooseYesNo(field, yes, 'kit', 'Follows from your explicit ethnicity in My Kit.')
        if (picked) return picked
      }
      return eeo(field, '')
    }
    case 'eeo_transgender': return eeo(field, '')
    case 'marketing_consent': {
      if (field.kind === 'checkbox') return answer(field, 'fill', ['false'], 'policy', 'Marketing messages are opt-in; left unchecked.')
      return chooseYesNo(field, false, 'policy', 'Marketing messages are opt-in.') ?? (field.required ? null : answer(field, 'skip', [], 'policy', 'Optional marketing consent.'))
    }
    case 'consent_ack': {
      // Acknowledging a policy or agreement the application requires. The
      // user approved applying; these are part of applying.
      if (field.kind === 'checkbox') return answer(field, 'fill', ['true'], 'policy', 'Required acknowledgement for this application.')
      if (field.kind === 'select' || field.kind === 'multiselect' || field.kind === 'boolean') {
        const agree = field.options.length === 1 ? field.options[0]! : field.options.find((option) => YES.test(option.label) || /\b(?:i (?:agree|acknowledge|confirm|accept|consent|understand|have read)|acknowledged?)\b/i.test(option.label))
        if (agree) return answer(field, 'fill', [agree.label], 'policy', 'Required acknowledgement for this application.')
      }
      return null
    }
    case 'work_auth':
    case 'sponsorship': {
      const derived = deriveWorkRights(field, dossier, job)
      if (!derived) return null
      const needsSponsorship = derived.kind === 'sponsorship' ? derived.yes : !derived.yes
      return chooseYesNo(field, derived.yes, 'derived', derived.reason) ?? workRightsOption(field, needsSponsorship, derived.reason)
    }
    case 'noncompete': {
      const stated = dossier.boundByAgreements.trim()
      if (!stated) return null
      const yes = /^\s*(?:yes|true)\b/i.test(stated)
      return chooseYesNo(field, yes, 'kit', `My Kit: bound by agreements = "${stated}".`) ?? fillWith(field, stated, 'kit', 'From My Kit.')
    }
    case 'work_auth_countries': {
      const codes = authorisedCountries(dossier.workAuthorization, dossier.location.countryCode)
      if (!codes.length) return null
      if (field.kind === 'text' || field.kind === 'textarea') return answer(field, 'fill', [dossier.workAuthorization.trim()], 'kit', 'The countries My Kit lists for your work authorisation.')
      if (field.kind === 'multiselect' || field.kind === 'select') {
        const picked = codes.map((code) => matchOption(field.options, [code, code === 'US' ? 'United States' : code === 'IN' ? 'India' : code === 'GB' ? 'United Kingdom' : code])).filter((option): option is FieldOption => option !== null)
        if (!picked.length) return null
        return answer(field, 'fill', field.kind === 'select' ? [picked[0]!.label] : [...new Set(picked.map((option) => option.label))], 'kit', 'The countries My Kit lists for your work authorisation.')
      }
      return null
    }
    case 'referral_source': {
      // Huntly finds postings on the employer's own job board.
      if (field.kind === 'text' || field.kind === 'textarea') return answer(field, 'fill', ['Company careers page'], 'policy', 'Found on the company careers page.')
      // In order of truthfulness, not best string match: "LinkedIn" must not beat "…website".
      const option = ['Company website', 'Careers page', 'Company careers page', 'Career site', 'Website', 'Job board', 'Job Board / Job Site', 'Online job board', 'Internet', 'Online', 'Other', 'LinkedIn']
        .map((alias) => matchOption(field.options, [alias])).find((match) => match !== null) ?? null
      return option ? answer(field, 'fill', [option.label], 'policy', 'Found through a job search.') : null
    }
    // Identity, not a fact the résumé implies: only what the user states.
    case 'pronouns': {
      if (!field.required) return answer(field, 'skip', [], 'policy', 'Pronouns are optional and not in My Kit.')
      const neutral = ['Use name only', 'Prefer not to say', 'I prefer not to say'].map((alias) => matchOption(field.options, [alias])).find((match) => match !== null)
      return neutral ? answer(field, 'fill', [neutral.label], 'policy', 'Pronouns are not in My Kit.') : missing(field, 'Your pronouns')
    }
    case 'conditional_followup': return field.required ? answer(field, 'fill', ['N/A'], 'policy', 'Follow-up to a choice that does not apply.', 0.9) : answer(field, 'skip', [], 'policy', 'Follow-up to a choice that does not apply.')
    case 'contact_preference': {
      if (field.kind === 'text' || field.kind === 'textarea') return answer(field, 'fill', ['Email'], 'policy', 'Email, the address on this application.')
      const option = matchOption(field.options, ['Email', 'E-mail'])
      return option ? answer(field, 'fill', [option.label], 'policy', 'Email, the address on this application.') : null
    }
    // Contacting a current employer can cost the user their job: never volunteered.
    case 'contact_employer': return chooseYesNo(field, false, 'policy', 'Your current employer is not contacted without asking you.')
    case 'start_date': {
      const notice = noticeIn('in days', 'number', dossier.noticePeriod || '')
      const days = /^\d+(?:\.\d+)?$/.test(notice) ? Number(notice) : null
      if (days === null) return null
      const date = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
      if (field.kind === 'date') return answer(field, 'fill', [date], 'derived', `Today plus your ${dossier.noticePeriod} notice period.`)
      if (field.kind === 'text' || field.kind === 'textarea') return answer(field, 'fill', [days === 0 ? 'Immediately' : `After my ${dossier.noticePeriod} notice period (from ${date})`], 'derived', 'From your notice period in My Kit.')
      const aliases = days === 0 ? ['Immediately', 'Immediate', 'Now'] : days <= 14 ? ['Within 2 weeks', '2 weeks', 'Less than 2 weeks'] : days <= 31 ? ['Within 1 month', '1 month', '30 days', 'Within 30 days', '2-4 weeks'] : days <= 62 ? ['1-2 months', '2 months', 'Within 2 months', '60 days'] : ['2-3 months', '3 months', '90 days', 'More than 2 months']
      const option = matchOption(field.options, aliases)
      return option ? answer(field, 'fill', [option.label], 'derived', 'From your notice period in My Kit.') : null
    }
    case 'office_commitment': {
      // Willingness, not location: follows from My Kit's relocation and work-mode answers.
      const relocates = /^\s*(?:yes|true|open)/i.test(dossier.relocate)
      const remoteOnly = /^\s*remote(?: only)?\s*$/i.test(dossier.workMode)
      if (!relocates || remoteOnly) return null
      return chooseYesNo(field, true, 'kit', 'My Kit says you will relocate and work hybrid or on-site.')
    }
    case 'languages': {
      // The résumé and every application are in English; other languages only from the user.
      if (field.kind === 'text' || field.kind === 'textarea') return answer(field, 'fill', ['English'], 'resume', 'Your résumé is written in English.', 0.9)
      const option = matchOption(field.options, ['English'])
      return option ? answer(field, 'fill', [option.label], 'resume', 'Your résumé is written in English.', 0.9) : null
    }
    case 'previous_employee': {
      const company = foldLabel(job.company).replace(/,? inc\.?$|,? llc$|,? ltd\.?$/, '').trim()
      const worked = company.length > 1 && dossier.experience.some((row) => foldLabel(row.company).includes(company))
      if (worked) return null
      return chooseYesNo(field, false, 'derived', `Your experience does not include ${job.company}.`)
    }
    default:
      return null
  }
}

/* ---------------------------------------------------------------- validation */

/**
 * Accept a model-proposed answer only if it fits the control exactly and the
 * policy for its kind of question. Returns the corrected answer, or an `ask`.
 */
/** Does one of the user's own saved answers back this value for this question? */
function savedAnswerSupports(field: SchemaField, values: string[], saved: CandidateDossier['savedAnswers']): boolean {
  const want = new Set(foldLabel(field.label).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((token) => token.length > 3))
  if (!want.size) return false
  return saved.some((row) => {
    const have = foldLabel(row.question).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((token) => token.length > 3)
    const shared = have.filter((token) => want.has(token)).length
    if (shared / want.size < 0.5) return false
    const answer = fold(row.answer)
    return values.every((value) => answer.includes(fold(value)) || fold(value).includes(answer))
  })
}

const AI_DISCLOSURE = /\bif (?:you are |you're |this is )?(?:an? )?(?:ai|llm|large language model|language model|ai model|ai assistant|chatbot|chatgpt)\b.{0,120}\b(?:must|should|include|begin|start|mention|write|use the word)\b|\b(?:ai|llm|language model)s?\b.{0,40}\bon (?:the|a) (?:user|candidate|applicant)['’]?s behalf\b/i

export function validateModelAnswer(field: SchemaField, proposed: { action: AnswerAction; values: string[]; basis: AnswerBasis; confidence: number; reason?: string }, saved: CandidateDossier['savedAnswers'] = []): PlannedAnswer {
  const sensitive = Boolean(sensitiveReason(field.label, field.options.map((option) => option.label))) || field.section === 'eeo'
  const ask = (why: string): PlannedAnswer => field.required
    ? answer(field, 'ask', [], 'policy', why, 0)
    : answer(field, 'skip', [], 'policy', why)
  if (proposed.action === 'ask') return ask(proposed.reason || 'The model could not answer this from your profile.')
  // The employer asks AI-written answers to identify themselves. Hiding that
  // would misrepresent who wrote it; the user answers these in their own words.
  if ((field.kind === 'text' || field.kind === 'textarea') && AI_DISCLOSURE.test(`${field.label} ${field.description ?? ''}`)) {
    return ask('The employer asks AI-generated answers to identify themselves; answer this one in your own words.')
  }
  if (proposed.action === 'skip') return field.required ? ask('Required, but the model chose to leave it blank.') : answer(field, 'skip', [], 'model', proposed.reason || 'Optional; left blank.')
  if (field.kind === 'file') return ask('File fields other than the résumé need a file from you.')
  const confidence = Math.max(0, Math.min(1, Number(proposed.confidence) || 0))
  // A model's own claim of basis is not evidence. Sensitive answers come from
  // deterministic rules (My Kit, derived work rights) or the user's saved
  // answers; from the model only when a saved answer actually supports them.
  const supported = proposed.basis === 'saved_answer' && confidence >= 0.8 && savedAnswerSupports(field, proposed.values, saved)
  if (sensitive && !supported) {
    const decline = field.section === 'eeo' ? declineOption(field.options) : null
    if (decline) return answer(field, 'fill', [decline.label], 'policy', 'Sensitive question without an explicit answer; declining.')
    return ask('A sensitive question needs your explicit answer.')
  }
  const floor = field.kind === 'textarea' || (field.kind === 'text' && proposed.basis === 'resume') ? 0.5 : 0.65
  if (confidence < floor) return ask(`Not confident enough to answer for you (${confidence.toFixed(2)}).`)
  const values = proposed.values.map((value) => String(value ?? '').trim()).filter(Boolean)
  if (!values.length) return ask('The model returned no value.')
  switch (field.kind) {
    case 'select':
    case 'boolean': {
      if (!field.options.length) return answer(field, 'fill', [values[0]!.slice(0, 200)], proposed.basis, proposed.reason ?? '', Math.min(confidence, 0.85))
      const option = matchOption(field.options, [values[0]!])
      if (!option) return ask(`"${values[0]}" is not one of this question's options.`)
      const exact = fold(option.label) === fold(values[0]!)
      return answer(field, 'fill', [option.label], proposed.basis, proposed.reason ?? '', exact ? confidence : Math.min(confidence, 0.75))
    }
    case 'multiselect': {
      if (!field.options.length) return answer(field, 'fill', values.map((value) => value.slice(0, 200)), proposed.basis, proposed.reason ?? '', Math.min(confidence, 0.85))
      const picked = values.map((value) => matchOption(field.options, [value])).filter((option): option is FieldOption => option !== null)
      if (!picked.length) return ask('None of the chosen values are options here.')
      return answer(field, 'fill', [...new Set(picked.map((option) => option.label))], proposed.basis, proposed.reason ?? '', confidence)
    }
    case 'checkbox':
      return answer(field, 'fill', [/^(?:true|yes|checked|1)$/i.test(values[0]!) ? 'true' : 'false'], proposed.basis, proposed.reason ?? '', confidence)
    case 'email':
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values[0]!) ? answer(field, 'fill', [values[0]!], proposed.basis, proposed.reason ?? '', confidence) : ask('Not a valid email address.')
    case 'url':
      return /^https?:\/\/\S+$/i.test(values[0]!) ? answer(field, 'fill', [values[0]!], proposed.basis, proposed.reason ?? '', confidence) : ask('Not a valid URL.')
    case 'date':
      return /\d/.test(values[0]!) ? answer(field, 'fill', [values[0]!], proposed.basis, proposed.reason ?? '', confidence) : ask('Not a date.')
    default: {
      const limit = field.kind === 'textarea' ? 3_000 : 500
      return answer(field, 'fill', [values[0]!.slice(0, limit)], proposed.basis, proposed.reason ?? '', confidence)
    }
  }
}

export { answer as plannedAnswer }
