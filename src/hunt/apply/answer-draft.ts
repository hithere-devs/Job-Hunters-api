import { credentialFieldReason, sensitiveReason, type FormField } from './fields.js'

export interface AnswerDraftFacts {
  role: string
  company: string
  headline?: string | null
  skills: string[]
  jobSkills: string[]
  experience: Array<{ role: string; company: string; description?: string | null }>
}
export interface AnswerDraft { draft: string | null; needsInfo: string[]; reason?: string }

const clean = (text: string) => text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
const words = (text: string, maximum: number) => clean(text).split(/\s+/).slice(0, maximum).join(' ')

/** A review-only draft from saved facts. No model, invented motive, or fabricated achievement. */
export function draftApplicationAnswer(field: FormField, facts: AnswerDraftFacts): AnswerDraft {
  if (credentialFieldReason(field) || sensitiveReason(field.label, field.options)) return { draft: null, needsInfo: ['Answer this question yourself. We do not infer sensitive information.'], reason: 'user_answer_required' }
  if (field.options?.length || !['text', 'textarea'].includes(field.type) || !/\b(?:why|motivat\w*|cover\s*letter|experience|example|describe|tell\s+us|background)\b/i.test(field.label)) return { draft: null, needsInfo: [], reason: 'not_a_draftable_question' }
  const needsInfo: string[] = []
  const sentences: string[] = []
  const experience = facts.experience[0]
  if (experience?.role && experience.company) sentences.push(`My experience includes working as ${words(experience.role, 8)} at ${words(experience.company, 8)}.`)
  else if (facts.headline?.trim()) sentences.push(`My professional background is ${words(facts.headline, 12)}.`)
  const matching = facts.skills.filter((skill) => facts.jobSkills.some((wanted) => wanted.toLowerCase() === skill.toLowerCase())).slice(0, 4)
  if (matching.length) sentences.push(`My skills include ${matching.map((skill) => words(skill, 3)).join(', ')}.`)
  if (/\b(?:example|describe|experience|background)\b/i.test(field.label) && experience?.description) sentences.push(words(experience.description, 20))
  if (/\b(?:why|motivat\w*|cover\s*letter)\b/i.test(field.label)) needsInfo.push(`Add your own reason for choosing ${clean(facts.company)} and this role; your profile does not establish your motivation.`)
  if (/\b(?:example|project|challenge|achievement)\b/i.test(field.label) && !experience?.description) needsInfo.push('Add a concrete example and outcome from your own experience.')
  if (!sentences.length) return { draft: null, needsInfo: ['Add your relevant experience or skills in My Kit, or write your own answer.'], reason: 'missing_profile_facts' }
  return { draft: words(sentences.join(' '), 60), needsInfo }
}
