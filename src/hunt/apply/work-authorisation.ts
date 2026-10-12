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
  // Abbreviations are case-sensitive: lowercase "us" is a pronoun ("tell us about…").
  [/\b[Uu]nited\s+[Ss]tates(?:\s+of\s+[Aa]merica)?\b|\bUSA\b|\bU\.S\.(?:A\.)?|\bUS\b/, 'US'],
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
  [/\bpoland\b/i, 'PL'], [/\bspain\b/i, 'ES'], [/\bportugal\b/i, 'PT'], [/\bitaly\b/i, 'IT'],
  [/\bsweden\b/i, 'SE'], [/\bdenmark\b/i, 'DK'], [/\bnorway\b/i, 'NO'], [/\bfinland\b/i, 'FI'],
  [/\bbelgium\b/i, 'BE'], [/\baustria\b/i, 'AT'], [/\b(?:czech\s+republic|czechia)\b/i, 'CZ'], [/\bromania\b/i, 'RO'],
  [/\bestonia\b/i, 'EE'], [/\blithuania\b/i, 'LT'], [/\blatvia\b/i, 'LV'], [/\bgreece\b/i, 'GR'], [/\bhungary\b/i, 'HU'],
  [/\bluxembourg\b/i, 'LU'], [/\bukraine\b/i, 'UA'], [/\bturkey|t[uü]rkiye\b/i, 'TR'], [/\bisrael\b/i, 'IL'],
  [/\bbrazil\b/i, 'BR'], [/\bmexico\b/i, 'MX'], [/\bargentina\b/i, 'AR'], [/\bcolombia\b/i, 'CO'], [/\bchile\b/i, 'CL'],
  [/\bphilippines\b/i, 'PH'], [/\bindonesia\b/i, 'ID'], [/\bmalaysia\b/i, 'MY'], [/\bvietnam\b/i, 'VN'], [/\bthailand\b/i, 'TH'],
  [/\b(?:south\s+korea|korea)\b/i, 'KR'], [/\bhong\s+kong\b/i, 'HK'], [/\btaiwan\b/i, 'TW'], [/\bchina\b/i, 'CN'],
  [/\bsaudi\s+arabia|\bksa\b/i, 'SA'], [/\bqatar\b/i, 'QA'], [/\begypt\b/i, 'EG'], [/\bsouth\s+africa\b/i, 'ZA'],
  [/\bnigeria\b/i, 'NG'], [/\bkenya\b/i, 'KE'], [/\bpakistan\b/i, 'PK'], [/\bbangladesh\b/i, 'BD'], [/\bsri\s+lanka\b/i, 'LK'],
  // Places that imply a country: tech-hub cities, US states, Canadian provinces.
  [/\b(?:london|manchester|edinburgh|cambridge,\s*uk)\b/i, 'GB'], [/\b(?:berlin|munich|m[uü]nchen|hamburg|frankfurt|cologne)\b/i, 'DE'],
  [/\bparis\b/i, 'FR'], [/\bamsterdam|rotterdam\b/i, 'NL'], [/\bdublin\b/i, 'IE'], [/\b(?:warsaw|krak[oó]w|wroc[lł]aw)\b/i, 'PL'],
  [/\b(?:madrid|barcelona)\b/i, 'ES'], [/\blisbon\b/i, 'PT'], [/\bstockholm\b/i, 'SE'], [/\b(?:zurich|z[uü]rich|geneva)\b/i, 'CH'],
  [/\b(?:sydney|melbourne)\b/i, 'AU'], [/\btel\s+aviv\b/i, 'IL'], [/\b(?:dubai|abu\s+dhabi)\b/i, 'AE'], [/\btokyo\b/i, 'JP'],
  [/\b(?:bengaluru|bangalore|mumbai|delhi|new\s+delhi|gurgaon|gurugram|noida|hyderabad|chennai|pune|kolkata|ahmedabad)\b/i, 'IN'],
  [/\b(?:california|new\s+york|washington|texas|massachusetts|illinois|colorado|georgia|florida|oregon|virginia|north\s+carolina|pennsylvania|new\s+jersey|arizona|utah|michigan|minnesota|ohio|tennessee|maryland|wisconsin|missouri|indiana|connecticut|nevada|san\s+francisco|bay\s+area|seattle|nyc|boston|austin|chicago|los\s+angeles|mountain\s+view|palo\s+alto|menlo\s+park|sunnyvale|san\s+jose|denver|atlanta)\b/i, 'US'],
  [/,\s*(?:AL|AK|AZ|AR|CA|CO|CT|FL|GA|HI|ID|IL|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/, 'US'],
  [/\b(?:ontario|british\s+columbia|quebec|alberta|toronto|vancouver|montreal)\b/i, 'CA'],
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
  // "…require our company to file a petition or application for employment-based
  // immigration status on your behalf" (Lever/Match Group) is sponsorship too.
  if (/\b(?:sponsor\w*|visa\s+status|work\s+permit|require\s+.{0,20}visa)\b/i.test(label) || /\bpetition\b.{0,120}\bimmigration\b|\bimmigration (?:status|case|benefit)\b.{0,60}\bon your behalf\b/i.test(label)) return 'sponsorship'
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
