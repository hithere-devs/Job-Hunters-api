import type { CandidateState } from './candidate-state.js'

export type ApplyQuestionKind =
  | 'gender'
  | 'orientation'
  | 'ethnicity'
  | 'veteran'
  | 'disability'
  | 'sponsorship'
  | 'work_auth'
  | 'based_in'
  | 'office_days'
  | 'which_office'
  | 'noncompete'
  | 'phone_country'
  | 'student'
  | 'start_date'
  | 'eeo_consent'
  | 'referral'
  | 'transgender'
  | 'other'

export interface ApplyPreferences {
  gender: string
  sexual_orientation: string
  ethnicity: string
  veteran: string
  disability: string
  current_city: string
  current_country: string
  work_mode: string
  work_authorization: string
  visa_sponsorship: string
  relocate: string
  bound_by_agreements: string
  onsite_five_days: string
}

export function classifyApplyQuestion(label: string): ApplyQuestionKind {
  const text = label.toLowerCase()
  if (/phone country|country code|dial(?:ling)? code|calling code/i.test(text)) return 'phone_country'
  if (/^country\s*\*?$/.test(text.trim())) return 'phone_country'
  if (/student or new grad|are you a (?:current )?student\b|new grad\??$/i.test(text) && !/earliest start|graduation/.test(text)) return 'student'
  if (/earliest start date|upon graduation|i am not a new grad/i.test(text)) return 'start_date'
  if (/by (?:selecting|checking|clicking).{0,80}(?:i agree|i consent)|candidate privacy policy|applicant privacy policy|acknowledge .{0,80}privacy|consent to reddit collecting|demographic data surveys/i.test(text)) return 'eeo_consent'
  if (/\b(?:how|where)\s+did\s+you\s+(?:hear|learn|find(?:\s+out)?)\b|\breferral source\b/i.test(text)) return 'referral'
  if (/transgender experience/i.test(text)) return 'transgender'
  if (/sexual\s+orientation|identify as\b.*straight|lgbt/i.test(text) && !/gender/.test(text)) return 'orientation'
  if (/gender\s+identity|what gender|identify my gender|sex\b(?!ual)/i.test(text)) return 'gender'
  if (/ethnicity|race\/?ethnicity|ethnicit|hispanic|latino|asian|indian\b/i.test(text) && /identify|race|ethnic|select/i.test(text)) return 'ethnicity'
  if (/\brace\b/.test(text) && !/race car|arms race/.test(text)) return 'ethnicity'
  if (/veteran/i.test(text)) return 'veteran'
  if (/disabilit/i.test(text)) return 'disability'
  if (/restrictive|non-?compete|bound by any agreement|current or former employer that may restrict/i.test(text)) return 'noncompete'
  if (/which office|select (?:both )?office|office are you applying|preferred office location|from where do you intend to work|intend to work|location \(city\)/i.test(text)) return 'which_office'
  if (/currently based in|are you (?:currently )?located in|based in this/i.test(text)) return 'based_in'
  if (/monday.?friday|on-?site work culture|willing to work in the office|work from the office \d days|hybrid schedule|in-office three days|commit to being in-office/i.test(text)) return 'office_days'
  if (/willing to relocat|relocate to |currently live or are you willing to relocate/i.test(text)) return 'office_days'
  if (/sponsor/i.test(text)) return 'sponsorship'
  if (/legally authorized to work|authorised to work|authorized to work|work authori[sz]ation|eligible to work|right to work in/i.test(text)) return 'work_auth'
  return 'other'
}

function fold(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ')
}

function optionBlocked(kind: ApplyQuestionKind | undefined, option: string, wanted: string): boolean {
  const hay = fold(option)
  const needle = fold(wanted)
  if (kind === 'ethnicity' && /american indian|alaska native|native american|native hawaiian/.test(hay) && /indian|asian|south asian/.test(needle) && !/^asian$/.test(hay) && !/asian indian|south asian|indian \(asian\)/.test(hay)) return true
  if (kind === 'ethnicity' && /east asian|southeast asian|west asian|central asian/.test(hay) && /indian|south asian|asian indian|^asian$/.test(needle)) return true
  if (kind === 'veteran' && /unspecified/.test(hay) && !/unspecified/.test(needle)) return true
  if (kind === 'veteran' && /vietnam|korean war|armed forces|recently separated|other protected/.test(hay) && /not a|i am not/.test(needle)) return true
  if (kind === 'veteran' && /not a|i am not|do not identify/.test(needle) && /protected veteran/.test(hay) && !/not a|i am not|do not/.test(hay)) return true
  if (kind === 'veteran' && /not a|i am not/.test(needle) && /^other /.test(hay)) return true
  return false
}

function pickClosest(options: string[], wanted: string[], kind?: ApplyQuestionKind): string | null {
  if (!options.length) return null
  let best: { option: string; score: number } | null = null
  for (const option of options) {
    const hay = fold(option)
    let score = 0
    for (const raw of wanted) {
      if (optionBlocked(kind, option, raw)) continue
      const needle = fold(raw)
      if (!needle) continue
      if (hay === needle) score = Math.max(score, 100)
      else if (hay.includes(needle) || needle.includes(hay)) score = Math.max(score, 80)
      else if (needle.split(' ').some((token) => token.length > 3 && hay.includes(token))) score = Math.max(score, 55)
    }
    if (!best || score > best.score) best = { option, score }
  }
  return best && best.score >= 55 ? best.option : null
}

function jobLooksLikeHome(jobLocation: string, city: string, country: string): boolean {
  const loc = fold(jobLocation)
  const homeCountry = fold(country)
  const homeCity = fold(city)
  if (homeCountry && (loc.includes(homeCountry) || loc.includes('india') && homeCountry.includes('india'))) return true
  if (homeCity && (loc.includes(homeCity) || (homeCity.includes('bangalore') && loc.includes('bengaluru')) || (homeCity.includes('bengaluru') && loc.includes('bangalore')))) return true
  return false
}

/** Kit is the source of truth. Review-application answers must not override these. */
export function kitSuggestion(params: {
  label: string
  options?: string[]
  candidate: CandidateState
}): { kind: ApplyQuestionKind; value: string | null; instruction: string } {
  const kind = classifyApplyQuestion(params.label)
  const prefs = params.candidate.preferences
  const options = params.options ?? []
  const jobLoc = params.candidate.job?.location ?? ''
  const city = prefs?.current_city || params.candidate.location.city
  const country = prefs?.current_country || params.candidate.location.country
  const atHome = jobLooksLikeHome(jobLoc, city, country)

  if (kind === 'phone_country') {
    const wanted = [country || 'India', '+91', 'IN', 'India (+91)', 'India +91']
    return {
      kind,
      value: pickClosest(options, wanted, kind) ?? wanted[0] ?? 'India',
      instruction: 'This is the phone dialing code for the candidate\'s own mobile number, NOT the job office country. Use India / +91 / IN. Ignore the posting location (Saudi Arabia, US, etc.). Kit overrides review answers.',
    }
  }
  if (kind === 'student') {
    const wanted = ['No', 'False']
    return { kind, value: pickClosest(options, wanted, kind) ?? 'No', instruction: 'The candidate is not a student or new graduate. Answer No. Kit overrides review answers.' }
  }
  if (kind === 'start_date') {
    const notGrad = options.find((option) => /not a new grad|not a student/i.test(option))
    const wanted = ['I am not a New Grad', 'I am not a student', 'Immediately/next few months, full-time', 'Immediately']
    return { kind, value: notGrad ?? pickClosest(options, wanted, kind) ?? wanted[0] ?? 'I am not a New Grad', instruction: 'Not a student or new grad. Prefer "I am not a New Grad"; otherwise the immediate full-time start. Kit overrides review answers.' }
  }
  if (kind === 'transgender') {
    const wanted = ['No', 'False']
    return { kind, value: pickClosest(options, wanted, kind) ?? 'No', instruction: 'The candidate is not a person of transgender experience. Answer No. Kit overrides review answers.' }
  }
  if (kind === 'referral') {
    const wanted = ['LinkedIn', 'Job board', 'Company website', 'Indeed', 'Other']
    return { kind, value: pickClosest(options, wanted, kind) ?? options.find((option) => /linkedin|job board|other/i.test(option)) ?? wanted[0] ?? 'LinkedIn', instruction: 'How they heard about the job is LinkedIn or Job board. Not a sensitive fact. Kit overrides review answers.' }
  }
  if (kind === 'eeo_consent') {
    if (!options.length) {
      return { kind, value: 'true', instruction: 'Check the EEO / demographic survey consent checkbox. Kit overrides review answers.' }
    }
    const wanted = ['I agree', 'Yes', 'true']
    return { kind, value: pickClosest(options, wanted, kind) ?? 'I agree', instruction: 'Check the EEO / demographic survey consent. This is not a sensitive fact. Kit overrides review answers.' }
  }
  if (kind === 'gender') {
    const wanted = [prefs?.gender || 'Male', 'Man', 'Male']
    return { kind, value: pickClosest(options, wanted, kind) ?? wanted[0] ?? 'Male', instruction: 'Gender is Male. Pick the closest option (Male / Man). Kit overrides review answers.' }
  }
  if (kind === 'orientation') {
    const wanted = [prefs?.sexual_orientation || 'Heterosexual', 'Straight', 'Heterosexual / Straight']
    return { kind, value: pickClosest(options, wanted, kind) ?? wanted[0] ?? 'Heterosexual', instruction: 'Sexual orientation is heterosexual/straight. Pick the closest option. Kit overrides review answers.' }
  }
  if (kind === 'ethnicity') {
    const wanted = ['Asian Indian', 'South Asian', 'Indian (Asian)', 'Asian', prefs?.ethnicity || 'Indian']
    const picked = pickClosest(options, wanted, kind)
    return { kind, value: picked ?? (options.length ? wanted[0] : 'Asian') ?? 'Asian', instruction: 'Ethnicity is Indian, which on US forms is Asian / Asian Indian / South Asian. Never pick American Indian, Native American, or Alaska Native. Kit overrides review answers.' }
  }
  if (kind === 'veteran') {
    const wanted = [prefs?.veteran || 'I am not a protected veteran', 'I am not a protected veteran', 'No military service', 'I am not a veteran', 'Not a veteran', 'No']
    return { kind, value: pickClosest(options, wanted, kind) ?? (options.find((option) => /no military service/i.test(option)) ?? 'I am not a protected veteran'), instruction: 'Veteran status is not a protected veteran / no military service. Never pick Vietnam Era, Unspecified, or Other Protected Veteran. Kit overrides review answers.' }
  }
  if (kind === 'disability') {
    const wanted = [prefs?.disability || 'No, I do not have a disability', 'No', 'I do not have a disability']
    return { kind, value: pickClosest(options, wanted, kind) ?? wanted[0] ?? 'No', instruction: 'Disability: no, I do not have a disability. Pick the closest wording. Kit overrides review answers.' }
  }
  if (kind === 'noncompete') {
    const wanted = [prefs?.bound_by_agreements || 'No']
    return { kind, value: pickClosest(options, wanted, kind) ?? 'No', instruction: 'Not bound by agreements that restrict work. Always No. Kit overrides review answers.' }
  }
  if (kind === 'office_days') {
    const wanted = [prefs?.onsite_five_days || 'Yes']
    return { kind, value: pickClosest(options, wanted, kind) ?? 'Yes', instruction: 'Willing to work on-site Monday–Friday when the employer asks. Always Yes. Kit overrides review answers.' }
  }
  if (kind === 'which_office') {
    if (options.length >= 2 && options.some((option) => /both/i.test(option))) {
      return { kind, value: pickClosest(options, ['both', 'select both'], kind) ?? options.find((option) => /both/i.test(option)) ?? options[0] ?? null, instruction: 'If both offices can be selected, select both. Otherwise pick the office that best matches the job location and the candidate current city / remote-hybrid preference.' }
    }
    return { kind, value: pickClosest(options, [jobLoc, city, country, 'Bengaluru', 'Bangalore'].filter(Boolean), kind) ?? city ?? options[0] ?? null, instruction: 'Pick the office or city closest to the candidate current city (Bangalore / Bengaluru) unless the form lists a specific office. If both can be selected, select both.' }
  }
  if (kind === 'based_in') {
    const yes = atHome
    const wanted = yes ? ['Yes', 'True'] : ['No', "No, I'm only able to work remotely", 'False']
    return { kind, value: pickClosest(options, wanted, kind) ?? (yes ? 'Yes' : 'No'), instruction: `Currently based in ${city}, ${country}. Answer whether they are currently based in the office/city this posting names. Do not treat willingness to relocate as currently based there.` }
  }
  if (kind === 'sponsorship') {
    const needsVisa = !atHome
    const wanted = needsVisa ? ['Yes', 'True'] : ['No', 'False']
    return {
      kind,
      value: pickClosest(options, wanted, kind) ?? (needsVisa ? 'Yes' : 'No'),
      instruction: `Visa sponsorship for THIS job. Job location: ${jobLoc || 'unknown'}. Candidate lives in ${city}, ${country}. Needs sponsorship outside India, including the US, even when the posting says remote. If the job is in India, sponsorship is No. Otherwise sponsorship is Yes.`,
    }
  }
  if (kind === 'work_auth') {
    const wanted = ['Yes', 'True', 'I am authorized', 'I am legally authorized', 'Authorized']
    return {
      kind,
      value: pickClosest(options, wanted, kind) ?? 'Yes',
      instruction: 'Authorized to work is always the closest Yes. Kit overrides review answers.',
    }
  }
  return { kind: 'other', value: null, instruction: 'My Kit is the source of truth. Review-application answers must not override Kit. Decide for this job using the full candidate record even if some fields seem unrelated.' }
}

export function applyPreferencesFromKit(kit: {
  gender?: string | null
  sexualOrientation?: string | null
  ethnicity?: string | null
  veteranStatus?: string | null
  disabilityStatus?: string | null
  city?: string | null
  country?: string | null
  workMode?: string | null
  workAuthorization?: string | null
  visaSponsorship?: string | null
  willingToRelocate?: string | null
  boundByAgreements?: string | null
}): ApplyPreferences {
  return {
    gender: kit.gender?.trim() || 'Male',
    sexual_orientation: kit.sexualOrientation?.trim() || 'Heterosexual / Straight',
    ethnicity: kit.ethnicity?.trim() || 'Indian',
    veteran: kit.veteranStatus?.trim() || 'I am not a protected veteran',
    disability: kit.disabilityStatus?.trim() || 'No, I do not have a disability',
    current_city: kit.city?.trim() || '',
    current_country: kit.country?.trim() || '',
    work_mode: kit.workMode?.trim() || 'hybrid',
    work_authorization: kit.workAuthorization?.trim() || '',
    visa_sponsorship: kit.visaSponsorship?.trim() || 'Required outside India',
    relocate: kit.willingToRelocate?.trim() || '',
    bound_by_agreements: kit.boundByAgreements?.trim() || 'No',
    onsite_five_days: 'Yes',
  }
}
