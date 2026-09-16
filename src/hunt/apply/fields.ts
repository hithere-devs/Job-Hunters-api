import { canonicalCommonQuestionKey, commonSensitiveQuestionId } from '../../persona/application-questions.js'
import crypto from 'node:crypto'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod/v4'
import { db } from '../../db/client.js'
import { fieldAnswers } from '../../db/schema.js'
import { hasModelAccess } from '../../config/env.js'
import { badRequest } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import { structured } from '../../model/gateway.js'
import type { PortalProfile } from '../portal-profile.js'
import { normaliseHttpUrl } from './urls.js'
import { answerForField, deriveAuthorisation, type AuthorisationContext } from './work-authorisation.js'

/**
 * Working out what a form field is asking, and what to put in it.
 *
 * Filling a field is trivial. Knowing *which* field is which is the whole
 * problem: every application form invents its own phrasing for the same
 * handful of questions, and there are thousands of forms.
 *
 * Three rungs, cheapest first — and the answer is cached, which is what makes
 * this get better rather than merely work. A strange question any user meets
 * is answered once and answered instantly forever after.
 */

export type Rung = 'recipe' | 'heuristic' | 'cache' | 'model' | 'agent' | 'consent' | 'derived' | 'skipped'

export interface FormField {
  /** The label as the form wrote it. */
  label: string
  /** `text`, `email`, `tel`, `select`, `textarea`, `checkbox`, `radio`, `file`. */
  type: string
  name?: string
  required: boolean
  options?: string[]
}

export interface ResolvedField {
  value: string | null
  via: Rung
  /** Set when the field must not be answered without the user. */
  blocked?: 'sensitive_field' | 'unknown_field'
}

/**
 * Questions we will never answer on someone's behalf.
 *
 * Not a capability gap — a decision. Getting a demographic answer, a visa
 * status or a salary expectation wrong on someone's application is not a bug
 * you can apologise for afterwards, and a plausible guess is worse than an
 * honest stop.
 */
const NEVER_AUTO: Array<[RegExp, string]> = [
  [/^(?:current|present)\s+(?:salary|ctc|compensation)(?:\s*\([^)]*\))?[*: ]*$/i, 'salary information'],
  // Word-stem matches, not whole words: "disabilit" must catch "disability"
  // and "disabilities", and a trailing \b makes it match neither. Getting this
  // wrong means silently answering a demographic question on someone's behalf.
  [
    /\b(?:gender|sexual\s+orientation|race|ethnicit\w*|hispanic|latino|veteran|disabilit\w*|lgbt\w*|pronouns)\b/i,
    'demographic question',
  ],
  // Both word orders: "salary expectation" and "expected salary" are the same
  // question, and forms use each about equally.
  [
    /\b(?:salary|compensation|ctc|remuneration|pay)\b[\s\S]{0,20}\b(?:expect\w*|desired|require\w*|range|ask)\b/i,
    'salary expectation',
  ],
  [
    /\b(?:expect\w*|desired|minimum|preferred)\b[\s\S]{0,20}\b(?:salary|compensation|ctc|remuneration|pay)\b/i,
    'salary expectation',
  ],
  [
    /\b(?:sponsorship|visa\b|work\s+authori[sz]ation|right\s+to\s+work|(?:legally\s+)?authori[sz]ed\s+to\s+work|eligible\s+to\s+work|permission\s+to\s+work|require\s+sponsorship)/i,
    'visa or work authorisation',
  ],
  [/\b(?:criminal|conviction|convicted|background\s+check|felony)\b/i, 'background question'],
  // Legal questions about existing obligations. Seen on a live GitLab form as
  // "Are you subject to any employment agreements and/or restrictive covenants
  // with your current employer?" — which matched the current-employer
  // heuristic and would have been answered with a company name.
  [
    /\b(?:non-?compete|restrictive\s+covenant|employment\s+agreement|notice\s+obligation|garden\s+leave)/i,
    'a legal question about your existing obligations',
  ],
  [/\b(?:reference|referee)s?\b[\s\S]{0,12}\b(?:name|contact|email|phone|detail)/i, 'a reference’s contact details'],
]

/** Login/verification secrets never enter the question/chat/cache pipeline. */
export function credentialFieldReason(field: FormField): string | null {
  const identity = `${field.label} ${field.name ?? ''}`.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ')
  if (field.type.toLowerCase() === 'password' || /\b(?:password|passphrase|passcode|captcha|recaptcha|otp|2fa|mfa|secret|authenticator|(?:api|private|recovery|secret)\s+key|(?:access|refresh|authentication|bearer)\s+token|recovery\s+(?:code|phrase)|(?:verification|security|authentication|login|one time|two factor)\s+code)\b/i.test(identity)) return 'Complete sign-in or verification yourself in browser setup. Never send credentials in chat.'
  return null
}

export function isContextualQuestion(field: FormField): boolean {
  return /\b(?:why|motivat\w*|cover\s*letter|this\s+(?:company|role|position|job)|our\s+(?:company|team|mission)|join\s+us)\b/i.test(field.label)
}

/**
 * Whether an answer the user gave explicitly may be reused on the next form.
 *
 * Two different things were collapsed here, and collapsing them is what made
 * the product feel like it forgot everything you told it.
 *
 * Refusing to *guess* someone's visa status, gender or veteran status is
 * correct and stays correct — `sensitiveReason` still blocks every automatic
 * rung from inventing one. But an answer the user typed themselves and asked us
 * to remember is a stable fact about them, and re-asking "are you legally
 * authorised to work in the US?" on every single application is not caution, it
 * is amnesia. Those answers were being stored with `remember: true` and then
 * discarded by this function on the way back out.
 *
 * What genuinely cannot carry over is anything whose truth is scoped to *this*
 * application: a reference's contact details, a background-check consent, an
 * attestation, or a legal question about obligations to a specific employer.
 */
const ANSWER_IS_APPLICATION_SPECIFIC = /background|reference|legal question/i

/**
 * Work authorisation only carries over when the question names the country.
 *
 * "Are you authorised to work in the United States?" is a fact about the
 * person: same answer on every US posting. "Are you authorised to work in the
 * country where you are applying?" is a fact about the *job* — the same person
 * answers yes in Bengaluru and no in New York — and reusing it would put a
 * wrong answer on a real application.
 *
 * An unqualified "Will you require sponsorship?" is the second kind: the
 * country is implied by the posting, not stated. Those keep getting asked.
 */
const WORK_AUTH_IS_JOB_RELATIVE =
  /\b(?:countr(?:y|ies)\s+(?:where|in\s+which|of|for)|this\s+countr|the\s+(?:job|role|position)\s+(?:is\s+)?(?:located|location)|where\s+(?:this\s+)?(?:job|role|position)|listed|applying\s+(?:to|for))\b/i
const WORK_AUTH_NAMES_A_COUNTRY =
  /\b(?:united\s+states|u\.?s\.?a?\b|usa|u\.?k\.?\b|united\s+kingdom|canada|india|australia|singapore|germany|france|ireland|netherlands|new\s+zealand|eu\b|european\s+union|schengen|switzerland|japan|uae|emirates)\b/i

export function canReuseExplicitAnswer(field: FormField): boolean {
  if (credentialFieldReason(field) || isContextualQuestion(field)) return false
  const reason = sensitiveReason(field.label, field.options)
  if (reason && ANSWER_IS_APPLICATION_SPECIFIC.test(reason)) return false
  if (reason && /visa or work authorisation/i.test(reason)) {
    if (WORK_AUTH_IS_JOB_RELATIVE.test(field.label)) return false
    if (!WORK_AUTH_NAMES_A_COUNTRY.test(field.label)) return false
  }
  return !/\b(?:certif\w*|attest\w*|declaration|employment\s+contract|legally\s+binding)\b/i.test(field.label)
}

export function validExplicitAnswer(field: FormField, value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 4000 || credentialFieldReason(field)) return null
  if (field.options?.length) return field.options.find((option) => option.trim().toLowerCase() === trimmed.toLowerCase()) ?? null
  if (field.type === 'checkbox') return /^(?:true|false)$/i.test(trimmed) ? trimmed.toLowerCase() : null
  return trimmed
}

const CONSENT_LABEL = /\b(?:privacy\s+policy|personal\s+data|store\s+and\s+process|consent|terms\s+(?:of\s+use|and\s+conditions))\b/i
const REFERRAL_LABEL = /\bhow\s+did\s+you\s+hear\s+about\s+us\b/i

/**
 * Answer values that give a demographic question away.
 *
 * Some forms give a radio group no legend at all, so its label ends up being
 * the first option — "Male" — which matches no question pattern. Ashby does
 * exactly this. Judging the group by what it is *offering* catches those, and
 * generalises across portals in a way that chasing each one's markup does not.
 */
const DEMOGRAPHIC_OPTIONS =
  /^(?:male|female|non-?binary|prefer\s+not|decline\s+to|hispanic|latino|asian|black|white|native\s+hawaiian|american\s+indian|two\s+or\s+more\s+races|i\s+identify\s+as|i\s+don'?t\s+wish)/i

export function sensitiveReason(label: string, options?: string[]): string | null {
  for (const [pattern, reason] of NEVER_AUTO) {
    if (pattern.test(label)) return reason
  }
  if (options && options.length >= 2) {
    const demographic = options.filter((option) => DEMOGRAPHIC_OPTIONS.test(option.trim()))
    // Two or more give-away options is a demographic question whatever it is
    // labelled; one could be a coincidence.
    if (demographic.length >= 2) return 'demographic question'
  }
  return null
}

/**
 * Strips the decoration forms put around a label.
 *
 * Required markers are not always an asterisk: Lever renders a heavy asterisk
 * (U+2731), others use a dagger or the word itself. Matching the raw label
 * meant an anchored pattern like /^(?:full\s*)?name$/ failed on "Full name✱",
 * so a Lever application could not fill the candidate's own name.
 */
export function normaliseLabel(label: string): string {
  return label
    .replace(/[\u2731\u066D\uFF0A*†‡]/g, '')
    .replace(/\((?:required|optional)\)/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[:\s]+$/, '')
    .trim()
}

/** Stable across cosmetic label changes, distinct across real ones. */
export function fieldSignature(field: FormField): string {
  const canonical = [
    normaliseLabel(field.label).toLowerCase(),
    field.type.toLowerCase(),
    (field.name ?? '').toLowerCase(),
  ].join('|')
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 20)
}

/* ------------------------------------------------------------ rung 2: rules */

/**
 * The label patterns that cover most of every form, mapped to the kit.
 *
 * This was the whole of the old implementation. It stays, because it is free
 * and it answers the majority of fields — it is simply no longer the only
 * thing between us and a stuck application.
 */
const HEURISTICS: Array<[RegExp, keyof PortalProfile | string]> = [
  [/^(?:full\s*)?name$|\byour name\b/i, 'fullName'],
  [/\bfirst\s*name\b|\bgiven name\b/i, 'firstName'],
  [/\blast\s*name\b|\bsurname\b|\bfamily name\b/i, 'lastName'],
  [/\be-?mail\b/i, 'email'],
  [/\b(?:phone|mobile|contact number)\b/i, 'phone'],
  [/\blinked-?in\b/i, 'linkedin'],
  [/\bgithub\b/i, 'github'],
  [/\b(?:portfolio|website|personal site)\b/i, 'portfolio'],
  [/\b(?:address|street)\b/i, 'addressLine1'],
  // `Location` on its own is what Ashby and Greenhouse label the city field,
  // and it blocked live applications as an `unknown_field` while the answer sat
  // in the kit. Anchored so it does not swallow "Location preference" or
  // "Are you willing to relocate", which are different questions.
  [/^\s*(?:current\s+)?location\s*\*?\s*$|\bcity\b|\btown\b|\b(?:current|based\s+in)\s+location\b/i, 'city'],
  [/\b(?:state|province|region)\b/i, 'region'],
  [/\b(?:postal|zip|pin)\s*code\b/i, 'postalCode'],
  [/\bcountry\b/i, 'country'],
  [/\b(?:notice period|availability|start date|when can you start)\b/i, 'noticePeriod'],
  [/\b(?:(?:current|present|most\s+recent)\s+(?:company|employer))\b/i, 'currentCompany'],
  [/\b(?:headline|current title|current role)\b/i, 'headline'],
  [/\b(?:years?\s+of\s+experience|total experience|experience in years)\b/i, 'totalExperience'],
]

export function valueFromProfile(key: string, profile: PortalProfile): string | null {
  const parts = profile.fullName.trim().split(/\s+/)
  const map: Record<string, string | undefined> = {
    fullName: profile.fullName,
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
    email: profile.email,
    phone: profile.phone,
    linkedin: normaliseHttpUrl(profile.links.linkedin),
    github: normaliseHttpUrl(profile.links.github),
    portfolio: normaliseHttpUrl(profile.links.portfolio),
    addressLine1: profile.address.line1,
    city: profile.address.city,
    region: profile.address.region,
    postalCode: profile.address.postalCode,
    country: profile.address.country,
    noticePeriod: profile.noticePeriod,
    headline: profile.headline,
    totalExperience: profile.totalExperience,
  }
  if (key === 'currentCompany') {
    const history = profile.experience ?? []
    const current = history.find((item) => item.isCurrent) ?? [...history].sort((a, b) => (b.endedOn ?? b.startedOn ?? '').localeCompare(a.endedOn ?? a.startedOn ?? ''))[0]
    return current?.company?.trim() || null
  }
  const value = map[key]
  return value && value.trim() ? value : null
}

/**
 * Above this, a label is a question rather than a field name.
 *
 * Heuristics match a phrase anywhere in the label, which is right for "Phone"
 * and wrong for a hundred-character question that merely contains the words
 * "current employer". Long labels go to the model rung, which can read the
 * whole sentence.
 */
const HEURISTIC_LABEL_LIMIT = 80

export function heuristicMatch(field: FormField): string | null {
  if (field.label.length > HEURISTIC_LABEL_LIMIT) return null
  const label = normaliseLabel(field.label)
  for (const [pattern, key] of HEURISTICS) {
    if (pattern.test(label)) return String(key)
  }
  return null
}

/* ------------------------------------------------------------ rung 3: model */

const mappingSchema = z.object({
  maps_to: z
    .string()
    .describe(
      'One of: fullName, firstName, lastName, email, phone, linkedin, github, portfolio, addressLine1, city, region, postalCode, country, noticePeriod, headline, totalExperience — or "none" when the question is not asking for any of them.',
    ),
  confidence: z.number().min(0).max(1),
})

const MAPPING_SYSTEM = `You map a job application form field onto a known candidate detail.

Answer "none" unless the field is clearly asking for one of the listed details. A wrong mapping puts a phone number in a cover letter box, which is worse than leaving it blank for a human.

Never map a field asking about salary, visa status, demographics, or criminal history. Those are answered by the candidate, not by you.`

/** Asks what an unfamiliar field wants. Cached afterwards, so asked once. */
async function mapWithModel(
  userId: string,
  field: FormField,
): Promise<{ mapsTo: string; confidence: number } | null> {
  if (!hasModelAccess) return null
  try {
    const answer = await structured(mappingSchema, {
      purpose: 'map-field',
      userId,
      system: MAPPING_SYSTEM,
      prompt: `Label: ${field.label}\nType: ${field.type}\nName: ${field.name ?? '(none)'}\nRequired: ${field.required}${
        field.options?.length ? `\nOptions: ${field.options.slice(0, 20).join(', ')}` : ''
      }`,
      effort: 'low',
      think: false,
      maxTokens: 500,
    })
    if (answer.maps_to === 'none' || answer.confidence < 0.6) return null
    return { mapsTo: answer.maps_to, confidence: answer.confidence }
  } catch (error) {
    logger.debug({ err: error, label: field.label }, 'field mapping failed')
    return null
  }
}

/* --------------------------------------------------------------- the ladder */

export interface ResolveContext {
  userId: string
  host: string
  profile: PortalProfile
  /** A recipe's answer for this field, when the portal has one. */
  fromRecipe?: string | null
  /** Job jurisdiction plus explicit user authorization/sponsorship answers. */
  authorisation?: AuthorisationContext
}

export async function resolveField(
  field: FormField,
  context: ResolveContext,
): Promise<ResolvedField> {
  if (credentialFieldReason(field)) return { value: null, via: 'skipped', blocked: 'sensitive_field' }
  const sensitive = sensitiveReason(field.label, field.options)

  // Only explicit country/topic answers qualify. Residence never establishes work rights.
  if (sensitive && /visa or work authorisation/i.test(sensitive) && context.authorisation && !context.profile.workAuthorization) {
    const derived = deriveAuthorisation(field, context.authorisation)
    if (derived) {
      const value = answerForField(field, derived.answer)
      if (value) return { value, via: 'derived' }
    }
  }

  const signature = fieldSignature(field)

  // The user's own answer first, then the shared mapping layer.
  const cached = await db
    .select()
    .from(fieldAnswers)
    .where(
      and(
        eq(fieldAnswers.host, context.host),
        eq(fieldAnswers.fieldSignature, signature),
        or(eq(fieldAnswers.userId, context.userId), isNull(fieldAnswers.userId)),
      ),
    )
    .limit(2)
    .catch(() => [])

  const own = cached.find((row) => row.userId === context.userId)
  const explicit = own?.confirmed && own.provenance === 'explicit_user' && own.value && canReuseExplicitAnswer(field) ? validExplicitAnswer(field, own.value) : null
  if (explicit) {
    await bumpUsage(own!.id)
    return { value: explicit, via: 'cache' }
  }

  const commonId = sensitive ? commonSensitiveQuestionId(field.label, field.type) : canonicalCommonQuestionKey(field)
  const profileKey = commonId ? ({ linkedinUrl: 'linkedin', githubUrl: 'github', portfolioUrl: 'portfolio' } as Record<string, string>)[commonId] ?? commonId : null
  const alreadyKnown = !sensitive && profileKey ? valueFromProfile(profileKey, context.profile) : null
  if (commonId && !alreadyKnown && !field.options?.length) {
    const [answer] = await db.select({ value: fieldAnswers.value }).from(fieldAnswers).where(and(eq(fieldAnswers.userId, context.userId), eq(fieldAnswers.host, 'profile'), eq(fieldAnswers.fieldSignature, `profile:${commonId}`), eq(fieldAnswers.provenance, 'explicit_user'), eq(fieldAnswers.confirmed, true))).limit(1).catch(() => [])
    const value = answer?.value ? validExplicitAnswer(field, answer.value) : null
    if (value && !(commonId === 'workAuthorization' && /^(?:yes|no|true|false)$/i.test(value.trim()))) return { value, via: 'cache' }
  }

  if (sensitive) return { value: null, via: 'skipped', blocked: 'sensitive_field' }

  // Consent is implicit in the user's request to apply. Checkbox controls use
  // the value only as a marker; fill.ts checks the control itself.
  if (field.type === 'checkbox' && CONSENT_LABEL.test(field.label)) {
    return { value: 'true', via: 'consent' }
  }
  if (REFERRAL_LABEL.test(field.label)) return { value: 'Job board', via: 'heuristic' }

  if (context.fromRecipe) return { value: context.fromRecipe, via: 'recipe' }



  const shared = cached.find((row) => row.userId === null)
  if (shared?.mapsTo) {
    const value = valueFromProfile(shared.mapsTo, context.profile)
    if (!value) return { value: null, via: 'skipped', ...(field.required ? { blocked: 'unknown_field' as const } : {}) }
    await bumpUsage(shared.id)
    return { value, via: 'cache' }
  }

  const heuristic = heuristicMatch(field)
  if (heuristic) {
    const value = valueFromProfile(heuristic, context.profile)
    if (value) return { value, via: 'heuristic' }
    return { value: null, via: 'skipped', ...(field.required ? { blocked: 'unknown_field' as const } : {}) }
  }

  const mapped = await mapWithModel(context.userId, field)
  if (mapped) {
    // Remember the mapping for everyone — it is a fact about the form, not
    // about this person. The value itself is never shared.
    await rememberMapping(context.host, signature, field.label, mapped.mapsTo)
    const value = valueFromProfile(mapped.mapsTo, context.profile)
    if (value) return { value, via: 'model' }
  }

  // Only a required field we cannot answer is worth stopping for.
  return {
    value: null,
    via: 'skipped',
    ...(field.required ? { blocked: 'unknown_field' as const } : {}),
  }
}

async function bumpUsage(id: string): Promise<void> {
  await db
    .update(fieldAnswers)
    .set({ timesUsed: sql`${fieldAnswers.timesUsed} + 1`, updatedAt: new Date() })
    .where(eq(fieldAnswers.id, id))
    .catch(() => undefined)
}

/** Shared layer: what this question is asking, never what this person answered. */
export async function rememberMapping(
  host: string,
  signature: string,
  label: string,
  mapsTo: string,
): Promise<void> {
  await db
    .insert(fieldAnswers)
    .values({ userId: null, host, fieldSignature: signature, label, mapsTo, provenance: 'model_mapping' })
    .onConflictDoNothing()
    .catch(() => undefined)
}

/** A value this user gave for this question. Private to them. */
export async function rememberAnswer(
  userId: string,
  host: string,
  field: FormField,
  value: string,
): Promise<void> {
  if (!userId || !canReuseExplicitAnswer(field)) throw badRequest('This question cannot be saved for reuse.')
  const safeValue = validExplicitAnswer(field, value)
  if (safeValue === null) throw badRequest('Choose an exact available option or provide a valid answer.')
  const signature = fieldSignature(field)
  await db
    .insert(fieldAnswers)
    .values({
      userId,
      host,
      fieldSignature: signature,
      label: field.label,
      value: safeValue,
      confirmed: true,
      provenance: 'explicit_user',
    })
    .onConflictDoUpdate({
      target: [fieldAnswers.userId, fieldAnswers.host, fieldAnswers.fieldSignature],
      set: { value: safeValue, confirmed: true, provenance: 'explicit_user', updatedAt: new Date() },
    })
}
