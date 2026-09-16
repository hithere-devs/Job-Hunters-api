import type { FormField } from './fields.js'

/** Work rights are explicit user facts, never inferred from residence. */
export interface AuthorisationContext {
  /** Residence only. This does not establish authorization or sponsorship. */
  candidateCountry: string | null
  /** ISO-3166 alpha-2 codes the posting is located in. */
  jobCountries: string[]
  /** True when the posting is remote and location may not bind. */
  remote?: boolean
  /** Explicit answers keyed by country and question topic. Never populate from residence. */
  explicitAnswers?: Record<string, { authorised?: boolean; sponsorship?: boolean }>
}

/** Countries named in question text, mapped to the codes the job data uses. */
const COUNTRY_ALIASES: Array<[RegExp, string]> = [
  [/\b(?:united\s+states(?:\s+of\s+america)?|u\.?s\.?a\.?|u\.?s\.?)\b/i, 'US'],
  [/\b(?:united\s+kingdom|u\.?k\.?|great\s+britain|england)\b/i, 'GB'],
  [/\bindia\b/i, 'IN'],
  [/\bcanada\b/i, 'CA'],
  [/\baustralia\b/i, 'AU'],
  [/\b(?:germany|deutschland)\b/i, 'DE'],
  [/\bfrance\b/i, 'FR'],
  [/\bireland\b/i, 'IE'],
  [/\bnetherlands\b/i, 'NL'],
  [/\bsingapore\b/i, 'SG'],
  [/\b(?:uae|united\s+arab\s+emirates)\b/i, 'AE'],
  [/\bswitzerland\b/i, 'CH'],
  [/\bjapan\b/i, 'JP'],
  [/\bnew\s+zealand\b/i, 'NZ'],
]

export function countryNamedIn(text: string): string | null {
  for (const [pattern, code] of COUNTRY_ALIASES) if (pattern.test(text)) return code
  return null
}

/** Which of the two questions this is, if either. */
export type AuthorisationQuestion = 'authorised' | 'sponsorship' | null

export function classifyAuthorisationQuestion(label: string): AuthorisationQuestion {
  // Sponsorship first: "will you require sponsorship to work in the US" also
  // may match the authorisation wording. The answers are separate facts.
  if (/\b(?:sponsor\w*|visa\s+status|work\s+permit|require\s+.{0,20}visa)\b/i.test(label)) return 'sponsorship'
  if (/\b(?:authori[sz]ed|authori[sz]ation|right\s+to\s+work|eligible\s+to\s+work|permission\s+to\s+work|legally\s+able)\b/i.test(label)) return 'authorised'
  return null
}

export interface DerivedAuthorisation {
  /** `true` meaning "yes" to whatever the question literally asked. */
  answer: boolean
  /** Why, in one line, for the audit trail. */
  basis: string
  jurisdiction: string
}

/**
 * Works out the answer, or returns null when it genuinely cannot.
 *
 * The jurisdiction is whichever the question names; failing that, the job's.
 * A question that names no country and a job with no country is unanswerable
 * — that is the null case, and it goes back to the user.
 */
export function deriveAuthorisation(
  field: FormField,
  context: AuthorisationContext,
): DerivedAuthorisation | null {
  const kind = classifyAuthorisationQuestion(field.label)
  if (!kind) return null

  const named = countryNamedIn(field.label)
  // A remote posting with several countries has no single jurisdiction to
  // reason about, so only collapse when they agree.
  const distinct = [...new Set(context.jobCountries)]
  const jurisdiction = named ?? (distinct.length === 1 ? distinct[0]! : null)
  if (!jurisdiction) return null

  const answer = context.explicitAnswers?.[jurisdiction]?.[kind]
  if (typeof answer !== 'boolean') return null
  return {
    answer,
    jurisdiction,
    basis: `Explicit user ${kind} answer for ${jurisdiction}.`,
  }
}

/**
 * Turns the derived boolean into something this particular control accepts.
 *
 * Forms ask the same question as a select, a radio group and a checkbox, and a
 * bare "true" typed into a select is not an answer. Returns null rather than
 * forcing a value the control does not offer.
 */
export function answerForField(field: FormField, answer: boolean): string | null {
  const options = field.options ?? []
  if (options.length > 0) {
    const yes = /^\s*(?:yes|y|true)\b/i
    const no = /^\s*(?:no|n|false)\b/i
    const match = options.find((option) => (answer ? yes : no).test(option))
    return match ?? null
  }
  if (field.type === 'checkbox') return answer ? 'true' : 'false'
  if (field.type === 'radio') return answer ? 'Yes' : 'No'
  return answer ? 'Yes' : 'No'
}

/**
 * A country name from the profile, as an ISO code.
 *
 * Profiles store a free-text country ("India", "United States"), while jobs
 * carry an ISO code. Null when the name is absent or unrecognised, which sends
 * the question back to the user rather than deriving from a guess.
 */
export function countryCodeFor(name: string | null | undefined): string | null {
  if (!name) return null
  const trimmed = name.trim()
  if (/^[A-Z]{2}$/.test(trimmed)) return trimmed
  return countryNamedIn(trimmed)
}
