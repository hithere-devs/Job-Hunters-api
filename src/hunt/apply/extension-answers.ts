import { answerTopic, type ResolvedApplicationAnswer } from '../../persona/answer-resolver-policy.js'
import { sensitiveReason, type FormField } from './fields.js'
import { validateLiveAnswer } from './question-policy.js'

const DEMOGRAPHIC = new Set(['gender', 'pronouns', 'ethnicity', 'disability', 'veteran'])
const AUTH_TOPICS = new Set(['work_authorization', 'sponsorship'])

export function isBatchResidue(field: FormField, resolved: { value: string | null; blocked?: string }): boolean {
  if (resolved.value) return false
  if (field.type === 'file') return false
  const topic = answerTopic(field)
  if (topic === 'credential' || topic === 'legal') return false
  if (DEMOGRAPHIC.has(topic)) return false
  if (resolved.blocked === 'sensitive_field') return AUTH_TOPICS.has(topic)
  return true
}

/** Options exact, sensitive topics blocked, invented facts (no evidence) dropped. */
export function acceptBatchAnswer(field: FormField, answer: ResolvedApplicationAnswer): string | null {
  if (field.fid && answer.questionId !== field.fid) return null
  if (answer.decision === 'ask' || !answer.answer?.trim()) return null
  if (!answer.autoApply && answer.evidence.length === 0) return null
  const topic = answerTopic(field)
  if (topic === 'credential' || topic === 'legal' || DEMOGRAPHIC.has(topic)) return null
  const sensitive = sensitiveReason(field.label, field.options)
  if (sensitive && !AUTH_TOPICS.has(topic) && topic !== 'professional' && topic !== 'contact') return null
  try {
    return validateLiveAnswer(field, { answer: answer.answer, remember: false, skip: false })
  } catch {
    return null
  }
}
