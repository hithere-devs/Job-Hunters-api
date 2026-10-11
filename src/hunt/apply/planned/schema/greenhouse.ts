import { greenhouseBoardFromUrl } from '../../greenhouse-schema.js'
import { htmlToText, schemaFingerprint } from './fingerprint.js'
import type { FieldKind, FieldOption, FormSchema, SchemaField } from './types.js'

/**
 * Greenhouse publishes every application form at
 * `boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}?questions=true`:
 * questions, location questions, EEOC compliance, the newer demographic
 * survey, and GDPR consent. Field names match the DOM ids on the hosted form.
 */

interface GhValue { label?: string; value?: string | number }
interface GhField { name?: string; type?: string; values?: GhValue[] }
interface GhQuestion { label?: string; required?: boolean; description?: string | null; fields?: GhField[] }
interface GhDemoOption { id?: number | string; label?: string; free_form?: boolean; decline_to_answer?: boolean }
interface GhDemoQuestion { id?: number | string; label?: string; required?: boolean; type?: string; answer_options?: GhDemoOption[] }
interface GhDataCompliance { type?: string; requires_consent?: boolean; requires_processing_consent?: boolean; requires_retention_consent?: boolean }

export interface GreenhouseJobPayload {
  title?: string
  company_name?: string
  questions?: GhQuestion[]
  location_questions?: GhQuestion[]
  compliance?: Array<{ type?: string; questions?: GhQuestion[]; description?: string }> | null
  demographic_questions?: { header?: string; description?: string; questions?: GhDemoQuestion[] } | null
  data_compliance?: GhDataCompliance[] | null
}

const PROFILE_NAMES = new Set(['first_name', 'last_name', 'preferred_name', 'email', 'phone', 'resume', 'resume_text', 'cover_letter', 'cover_letter_text'])

function optionsOf(values: GhValue[] | undefined): FieldOption[] {
  return (values ?? [])
    .map((value) => ({ label: String(value.label ?? '').trim(), ...(value.value !== undefined ? { value: String(value.value) } : {}) }))
    .filter((option) => option.label)
}

function textKind(name: string, label: string): FieldKind {
  if (name === 'email' || /\be-?mail\b/i.test(label)) return 'email'
  if (name === 'phone' || /\bphone\b|mobile number/i.test(label)) return 'phone'
  if (/linkedin|github|portfolio|website|url\b|personal site/i.test(label)) return 'url'
  return 'text'
}

function fromQuestion(question: GhQuestion, section: SchemaField['section']): SchemaField | null {
  const label = String(question.label ?? '').trim()
  const fields = (question.fields ?? []).filter((field) => field.type !== 'input_hidden')
  if (!label || !fields.length) return null
  const file = fields.find((field) => field.type === 'input_file')
  const primary = file ?? fields[0]!
  const name = String(primary.name ?? '')
  const description = question.description ? htmlToText(question.description).slice(0, 600) : undefined
  const base = {
    key: `gh:${name || label}`,
    label,
    ...(description ? { description } : {}),
    required: Boolean(question.required),
    ...(name ? { atsName: name } : {}),
    section: section === 'question' && PROFILE_NAMES.has(name) ? 'profile' as const : section,
  }
  if (file) {
    const fileRole = /cover/i.test(name) ? 'cover_letter' as const : /resume|cv/i.test(`${name} ${label}`) ? 'resume' as const : 'other' as const
    return { ...base, kind: 'file', options: [], fileRole }
  }
  switch (primary.type) {
    case 'textarea':
      return { ...base, kind: 'textarea', options: [] }
    case 'multi_value_single_select':
      return { ...base, kind: 'select', options: optionsOf(primary.values) }
    case 'multi_value_multi_select':
      return { ...base, kind: 'multiselect', options: optionsOf(primary.values) }
    case 'input_text':
    default:
      return { ...base, kind: section === 'location' ? 'location' : textKind(name, label), options: [] }
  }
}

export function parseGreenhousePayload(payload: GreenhouseJobPayload, url: string): FormSchema {
  const fields: SchemaField[] = []
  const push = (field: SchemaField | null) => {
    if (field && !fields.some((existing) => existing.key === field.key)) fields.push(field)
  }
  for (const question of payload.questions ?? []) push(fromQuestion(question, 'question'))
  for (const question of payload.location_questions ?? []) push(fromQuestion(question, 'location'))
  for (const block of payload.compliance ?? []) {
    for (const question of block.questions ?? []) push(fromQuestion(question, 'eeo'))
  }
  for (const question of payload.demographic_questions?.questions ?? []) {
    const label = String(question.label ?? '').trim()
    if (!label) continue
    push({
      key: `gh:demographic_${question.id ?? label}`,
      label,
      kind: question.type === 'multi_value_multi_select' ? 'multiselect' : 'select',
      required: Boolean(question.required),
      options: (question.answer_options ?? [])
        .filter((option) => !option.free_form)
        .map((option) => ({ label: String(option.label ?? '').trim(), ...(option.id !== undefined ? { value: String(option.id) } : {}) }))
        .filter((option) => option.label),
      section: 'eeo',
    })
  }
  for (const consent of payload.data_compliance ?? []) {
    if (consent.type !== 'gdpr') continue
    if (consent.requires_consent || consent.requires_processing_consent) {
      push({ key: 'gh:gdpr_processing_consent', label: 'I consent to the processing of my personal data for this application', kind: 'checkbox', required: true, options: [], section: 'consent' })
    }
    if (consent.requires_retention_consent) {
      push({ key: 'gh:gdpr_retention_consent', label: 'I consent to the retention of my personal data', kind: 'checkbox', required: true, options: [], section: 'consent' })
    }
  }
  return {
    source: 'greenhouse',
    url,
    fields,
    ...(payload.title ? { title: payload.title } : {}),
    ...(payload.company_name ? { company: payload.company_name } : {}),
    fingerprint: schemaFingerprint(fields),
  }
}

export async function loadGreenhouseSchema(url: string, fetchImpl: typeof fetch = fetch): Promise<FormSchema | null> {
  const board = greenhouseBoardFromUrl(url)
  if (!board) return null
  const response = await fetchImpl(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs/${encodeURIComponent(board.jobId)}?questions=true`,
    { signal: AbortSignal.timeout(12_000), headers: { accept: 'application/json' } },
  )
  if (response.status === 404) return { source: 'greenhouse', url, fields: [], closed: true, fingerprint: 'closed' }
  if (!response.ok) throw new Error(`Greenhouse questions API returned HTTP ${response.status}`)
  return parseGreenhousePayload((await response.json()) as GreenhouseJobPayload, url)
}
