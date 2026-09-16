import { readParsedResume } from '../services/resume-parser.js'
import { APPLY_QUESTION_SPECS, type ApplyFieldId } from './application-questions.js'
export type { ApplyFieldId } from './application-questions.js'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { fieldAnswers, kits, resumes } from '../db/schema.js'

/**
 * The answers a form needs, collected at the moment they are first needed.
 *
 * Intake deliberately never asks for these: a phone number cannot reorder
 * anyone's search results, so asking for it up front costs drop-off and buys
 * nothing. That deferral left a real gap, though — the old wizard used to
 * collect them, and nothing replaced it, so the first application would reach
 * `loadPortalProfile`, throw "phone is required in My Kit", and surface to the
 * user as a *failed application* rather than a question.
 *
 * A missing field should be a prompt before the run, not a casualty during it.
 */

const SPECS = APPLY_QUESTION_SPECS
type FieldSpec = (typeof APPLY_QUESTION_SPECS)[number]

export interface ApplyFieldsState {
  /** Everything a portal form might ask, with whatever we already know. */
  fields: Array<FieldSpec & { value: string | null }>
  /** Ids that block applying entirely. */
  missingRequired: ApplyFieldId[]
  /** Ids that will cause individual attempts to park for review. */
  missingOptional: ApplyFieldId[]
  /** True when nothing blocks a run. */
  canApply: boolean
  /** Separate from the fields: applying needs something to attach. */
  hasBaseResume: boolean
  resumeStatus: string
}

function valueOf(kit: Record<string, unknown> | undefined, id: ApplyFieldId): string | null {
  const raw = kit?.[id]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export async function readApplyFields(userId: string): Promise<ApplyFieldsState> {
  const [kit] = await db.select().from(kits).where(eq(kits.userId, userId)).limit(1)
  const [baseResume] = await db.select({ id: resumes.id, parseStatus: resumes.parseStatus, parsedProfile: resumes.parsedProfile }).from(resumes).where(and(eq(resumes.userId, userId), eq(resumes.isBase, true))).limit(1)
  const explicit = await db.select({ signature: fieldAnswers.fieldSignature }).from(fieldAnswers).where(and(eq(fieldAnswers.userId, userId), eq(fieldAnswers.host, 'profile'), eq(fieldAnswers.provenance, 'explicit_user'), eq(fieldAnswers.confirmed, true)))


  const parsed = baseResume?.parseStatus === 'parsed' ? readParsedResume(baseResume.parsedProfile) : null
  const known = { ...parsed?.contact, ...Object.fromEntries(Object.entries(kit ?? {}).filter(([, value]) => value !== null && value !== '')) }
  const explicitIds = new Set(explicit.map((row) => row.signature))
  const fields = SPECS.map((spec) => ({ ...spec, value: valueOf(known, spec.id), explicitlyProvided: explicitIds.has(`profile:${spec.id}`) }))
  const missingRequired = fields.filter((f) => f.required && !f.value).map((f) => f.id)
  const missingOptional = fields.filter((f) => !f.required && !f.value).map((f) => f.id)

  return {
    fields,
    missingRequired,
    missingOptional,
    canApply: missingRequired.length === 0 && baseResume?.parseStatus === 'parsed',
    hasBaseResume: Boolean(baseResume),
    resumeStatus: baseResume?.parseStatus ?? 'absent',
  }
}

/**
 * Writes answers into the kit, which is where the apply runtime already reads
 * them from. Deliberately not a new table: two homes for a phone number is how
 * they drift apart.
 */
export async function saveApplyFields(
  userId: string,
  answers: Partial<Record<ApplyFieldId, string>>,
): Promise<ApplyFieldsState> {
  const patch: Record<string, string | null> = {}
  for (const spec of SPECS) {
    const value = answers[spec.id]
    if (value === undefined) continue
    const trimmed = value.trim()
    // An empty string means "clear this", not "store a blank".
    patch[spec.id] = trimmed.length > 0 ? trimmed : null
  }

  if (Object.keys(patch).length > 0) {
    await db.transaction(async (tx) => {
      await tx.insert(kits).values({ userId, ...patch }).onConflictDoUpdate({ target: kits.userId, set: { ...patch, updatedAt: new Date() } })
      for (const spec of SPECS) {
        if (answers[spec.id] === undefined) continue
        await tx.insert(fieldAnswers).values({ userId, host: 'profile', fieldSignature: `profile:${spec.id}`, label: spec.label, value: patch[spec.id] ?? null, confirmed: true, provenance: 'explicit_user' }).onConflictDoUpdate({ target: [fieldAnswers.userId, fieldAnswers.host, fieldAnswers.fieldSignature], set: { value: patch[spec.id] ?? null, confirmed: true, provenance: 'explicit_user', updatedAt: new Date() } })
      }
    })
  }

  return readApplyFields(userId)
}

/** Human-readable list for an error the user will actually read. */
export function describeMissing(ids: ApplyFieldId[]): string {
  const labels = ids.map((id) => SPECS.find((spec) => spec.id === id)?.label ?? id)
  // Guard the empty case explicitly: the join branch would otherwise reach
  // past the end of the array and render "and undefined" into a sentence the
  // user reads.
  if (labels.length === 0) return ''
  if (labels.length === 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}
