import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../../db/client.js'
import { pendingApplicationQuestions } from '../../../db/schema.js'
import { fieldSignature, sensitiveReason } from '../fields.js'
import { forbiddenQuestion } from '../question-policy.js'
import { validateModelAnswer, type PlannedAnswer } from './answers.js'
import type { FieldKind, SchemaField } from './schema/types.js'

/**
 * Plan questions live in the existing question inbox, so answering them, the
 * batch answer screen and automatic resume all work unchanged. The signature
 * is derived from the schema, so the next attempt finds the answer again.
 */

const QUESTION_TYPE: Record<FieldKind, string> = {
  text: 'text', textarea: 'textarea', email: 'email', phone: 'tel', url: 'url', number: 'number', date: 'date',
  select: 'select', multiselect: 'select', boolean: 'radio', checkbox: 'checkbox', file: 'file', location: 'text',
}

export function questionType(field: SchemaField): string {
  return QUESTION_TYPE[field.kind]
}

export function questionSignature(field: SchemaField): string {
  return fieldSignature({ label: field.label, type: questionType(field), required: field.required, ...(field.atsName ? { name: field.atsName } : {}) })
}

/** Record every required field the plan could not answer. Returns how many were recorded. */
export async function recordPlanQuestions(params: {
  userId: string
  applicationId: string
  attemptId: string
  host: string
  fields: SchemaField[]
  answers: PlannedAnswer[]
}): Promise<number> {
  const asks = params.answers.filter((answer) => answer.action === 'ask' && answer.required)
  if (!asks.length) return 0
  const fields = new Map(params.fields.map((field) => [field.key, field]))
  const expiresAt = new Date(Date.now() + 14 * 86_400_000)
  const rows = asks.flatMap((answer) => {
    const field = fields.get(answer.key)
    if (!field) return []
    const type = questionType(field)
    if (forbiddenQuestion({ label: field.label, type, ...(field.atsName ? { name: field.atsName } : {}) })) return []
    return [{
      userId: params.userId,
      applicationId: params.applicationId,
      attemptId: params.attemptId,
      host: params.host,
      fieldSignature: questionSignature(field),
      fieldName: field.atsName ?? field.key,
      label: field.label,
      type,
      options: field.options.map((option) => option.label),
      required: true,
      sensitive: Boolean(sensitiveReason(field.label, field.options.map((option) => option.label))) || field.section === 'eeo',
      status: 'pending',
      remember: field.section !== 'eeo' && !sensitiveReason(field.label),
      blockedReason: answer.reason ?? null,
      expiresAt,
    }]
  })
  if (!rows.length) return 0
  await db.insert(pendingApplicationQuestions).values(rows).onConflictDoNothing()
  return rows.length
}

/**
 * The user's answers to this application's earlier questions, keyed by the
 * schema-derived signature, validated against the field's current options.
 */
export async function userAnswersForApplication(userId: string, applicationId: string, fields: SchemaField[]): Promise<Map<string, PlannedAnswer>> {
  const rows = await db
    .select({ signature: pendingApplicationQuestions.fieldSignature, label: pendingApplicationQuestions.label, answer: pendingApplicationQuestions.answer, answerMeta: pendingApplicationQuestions.answerMeta })
    .from(pendingApplicationQuestions)
    .where(and(
      eq(pendingApplicationQuestions.userId, userId),
      eq(pendingApplicationQuestions.applicationId, applicationId),
      inArray(pendingApplicationQuestions.status, ['answered', 'applied', 'expired']),
      sql`${pendingApplicationQuestions.answer} is not null`,
    ))
    .orderBy(desc(pendingApplicationQuestions.updatedAt))
  const bySignature = new Map<string, string>()
  const byLabel = new Map<string, string>()
  for (const row of rows) {
    if (!row.answer) continue
    if (!bySignature.has(row.signature)) bySignature.set(row.signature, row.answer)
    const label = row.label.replace(/\s+/g, ' ').trim().toLowerCase()
    if (!byLabel.has(label)) byLabel.set(label, row.answer)
  }
  const out = new Map<string, PlannedAnswer>()
  for (const field of fields) {
    const value = bySignature.get(questionSignature(field)) ?? byLabel.get(field.label.replace(/\s+/g, ' ').trim().toLowerCase())
    if (!value) continue
    const validated = validateModelAnswer(field, { action: 'fill', values: [value], basis: 'saved_answer', confidence: 1, reason: 'Your answer to this question.' })
    if (validated.action === 'fill') out.set(field.key, validated)
  }
  return out
}
