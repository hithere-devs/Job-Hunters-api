import { z } from 'zod'

export const APPLY_QUESTION_SPECS = [
  { id: 'fullName', label: 'Full name', required: true, inputType: 'text', group: 'contact' },
  { id: 'email', label: 'Email for applications', required: true, inputType: 'email', group: 'contact', help: 'Review the contact email you want employers to use. It can differ from your product login.' },
  { id: 'phone', label: 'Phone number', required: true, inputType: 'tel', group: 'contact' },
  { id: 'city', label: 'City', required: false, inputType: 'text', group: 'location' },
  { id: 'country', label: 'Country', required: false, inputType: 'text', group: 'location' },
  { id: 'addressLine1', label: 'Street address', required: false, inputType: 'text', group: 'location' },
  { id: 'state', label: 'State or province', required: false, inputType: 'text', group: 'location' },
  { id: 'postalCode', label: 'Postal code', required: false, inputType: 'text', group: 'location' },
  { id: 'linkedinUrl', label: 'LinkedIn profile URL', required: true, inputType: 'url', group: 'profile', help: 'Most ATS forms ask for this. Save the full https URL.' },
  { id: 'githubUrl', label: 'GitHub URL', required: true, inputType: 'url', group: 'profile', help: 'Required. Employer forms that ask for GitHub will use this exactly.' },
  { id: 'portfolioUrl', label: 'Portfolio or personal website', required: false, inputType: 'url', group: 'profile' },
  { id: 'totalExperience', label: 'Total experience', required: false, inputType: 'text', group: 'profile' },
  { id: 'noticePeriod', label: 'Notice period', required: false, inputType: 'text', group: 'preferences', help: 'Copied exactly. Legal obligations are confirmed separately for each application.' },
  { id: 'currentCtc', label: 'Current salary', required: false, inputType: 'text', group: 'preferences', sensitive: true, help: 'Optional. Include currency and pay period. Never inferred from your resume.' },
  { id: 'expectedCtc', label: 'Expected salary', required: false, inputType: 'text', group: 'preferences', sensitive: true, help: 'Optional. Include currency and pay period. Forms asking a different currency or range require your answer.' },
  { id: 'workAuthorization', label: 'Work authorisation', required: false, inputType: 'text', group: 'preferences', sensitive: true, help: 'Countries you are already authorized to work in, not just yes or no.' },
  { id: 'visaSponsorship', label: 'Where you need visa sponsorship', required: false, inputType: 'text', group: 'preferences', help: 'Example: Required outside India. Used with the job location to answer sponsorship questions.' },
  { id: 'workMode', label: 'Remote / hybrid / on-site preference', required: false, inputType: 'text', group: 'preferences' },
  { id: 'willingToRelocate', label: 'Willing to relocate?', required: false, inputType: 'text', group: 'preferences', help: 'Optional. Specify where, if applicable.' },
  { id: 'gender', label: 'Gender', required: false, inputType: 'text', group: 'demographic' },
  { id: 'sexualOrientation', label: 'Sexual orientation', required: false, inputType: 'text', group: 'demographic' },
  { id: 'ethnicity', label: 'Race / ethnicity', required: false, inputType: 'text', group: 'demographic' },
  { id: 'veteranStatus', label: 'Veteran status', required: false, inputType: 'text', group: 'demographic', help: 'Closest match to “I am not a veteran / not a protected veteran” unless you say otherwise.' },
  { id: 'disabilityStatus', label: 'Disability status', required: false, inputType: 'text', group: 'demographic' },
  { id: 'boundByAgreements', label: 'Bound by a non-compete or similar agreement?', required: false, inputType: 'text', group: 'preferences', help: 'Usually No.' },
] as const
export type ApplyFieldId = (typeof APPLY_QUESTION_SPECS)[number]['id']

const short = z.string().max(200)
const url = z.union([z.literal(''), z.string().url().max(1000).refine((value) => { try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password } catch { return false } }, 'Use an HTTP or HTTPS URL without credentials')])
export const applyFieldsSchema = z.object({
  fullName: z.string().max(120).optional(), email: z.union([z.literal(''), z.string().email().max(254)]).optional(), phone: z.string().max(40).optional(),
  city: short.optional(), country: short.optional(), addressLine1: short.optional(), state: short.optional(), postalCode: z.string().max(30).optional(),
  linkedinUrl: url.optional(), githubUrl: url.optional(), portfolioUrl: url.optional(), totalExperience: z.string().max(80).optional(),
  noticePeriod: z.string().max(80).optional(), currentCtc: z.string().max(80).optional(), expectedCtc: z.string().max(80).optional(), workAuthorization: short.refine((value) => !/^(?:yes|no|true|false)$/i.test(value.trim()), 'Include the country and your work-authorisation situation, not just yes or no').optional(), visaSponsorship: short.optional(), workMode: short.optional(), willingToRelocate: short.optional(), gender: short.optional(), sexualOrientation: short.optional(), ethnicity: short.optional(), veteranStatus: short.optional(), disabilityStatus: short.optional(), boundByAgreements: short.optional(),
}).strict()

/** Only semantically identical free-text questions can reuse sensitive profile answers. */
export function commonSensitiveQuestionId(label: string, type: string): ApplyFieldId | null {
  if (!['text', 'textarea', 'number'].includes(type)) return null
  const normalized = label.toLowerCase().replace(/[*:]/g, '').replace(/\s+/g, ' ').trim()
  if (normalized === 'current salary') return 'currentCtc'
  if (normalized === 'expected salary') return 'expectedCtc'
  if (normalized === 'work authorisation' || normalized === 'work authorization') return 'workAuthorization'
  return null
}

export interface CommonQuestionField { label: string; type: string; name?: string; options?: string[] }

/** These labels ask for the same personal fact, regardless of employer/ATS host. */
export function canonicalCommonQuestionKey(field: CommonQuestionField): ApplyFieldId | null {
  if (!['text', 'url', 'email', 'tel', 'textarea'].includes(field.type.toLowerCase()) || field.options?.length) return null
  const label = field.label.replace(/[\u2731\u066D\uFF0A*†‡]/g, '').replace(/\((?:required|optional)\)/gi, '').replace(/\s*[-–—]\s*no fact provided\s*$/i, '').replace(/\s+/g, ' ').replace(/[:\s]+$/, '').trim()
  if (/^(?:your\s+)?linked[- ]?in(?:\s+(?:profile(?:\s+(?:url|link))?|url|link))?$/i.test(label)) return 'linkedinUrl'
  if (/github/i.test(label) && /url|profile|link|username|handle/i.test(label)) return 'githubUrl'
  if (/^(?:your\s+)?(?:portfolio(?:\s+(?:url|link|website))?|personal\s+website(?:\s+url)?)$/i.test(label)) return 'portfolioUrl'
  if (/^(?:your\s+)?full\s+name$/i.test(label)) return 'fullName'
  if (/^(?:your\s+)?e-?mail(?:\s+(?:address|for\s+applications))?$/i.test(label)) return 'email'
  if (/^(?:your\s+)?(?:phone|mobile)(?:\s+number)?$/i.test(label)) return 'phone'
  return null
}
