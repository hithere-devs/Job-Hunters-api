import type { FormField } from './fields.js'

/**
 * Greenhouse Job Board questions API is the option list of record.
 *
 * Combobox widgets on job-boards.greenhouse.io ship empty until a flyout
 * opens, so EEO decline-to-answer never fires from inventory alone. Fetching
 * `?questions=true` gives the real labels — including `decline_to_answer`.
 */

export interface GreenhouseBoardRef {
  token: string
  jobId: string
}

export interface GreenhouseSchemaField {
  label: string
  required: boolean
  name?: string
  options: string[]
}

export type GreenhouseSchemaLoad =
  | { status: 'ok'; fields: GreenhouseSchemaField[] }
  | { status: 'missing' }
  | { status: 'skip' }

interface GreenhouseValue {
  label?: string
}

interface GreenhouseApiField {
  name?: string
  type?: string
  values?: GreenhouseValue[]
}

interface GreenhouseApiQuestion {
  label?: string
  required?: boolean
  fields?: GreenhouseApiField[]
}

interface GreenhouseDemoOption {
  label?: string
  decline_to_answer?: boolean
}

interface GreenhouseDemoQuestion {
  label?: string
  required?: boolean
  answer_options?: GreenhouseDemoOption[]
}

interface GreenhouseJobQuestions {
  questions?: GreenhouseApiQuestion[]
  location_questions?: GreenhouseApiQuestion[]
  demographic_questions?: { questions?: GreenhouseDemoQuestion[] } | null
  compliance?: Array<{ questions?: GreenhouseApiQuestion[] }>
}

export function greenhouseBoardFromUrl(url: string): GreenhouseBoardRef | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (!(host === 'job-boards.greenhouse.io' || host === 'boards.greenhouse.io' || host.endsWith('.greenhouse.io'))) {
      return null
    }
    const board = parsed.searchParams.get('for')
    const embedJob = parsed.searchParams.get('token')
    if (board && embedJob && /^\d+$/.test(embedJob)) {
      return { token: board.toLowerCase(), jobId: embedJob }
    }
    const match = parsed.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/i)
    const token = match?.[1]
    const jobId = match?.[2]
    if (token && jobId) return { token: token.toLowerCase(), jobId }
    return null
  } catch {
    return null
  }
}

export async function greenhouseJobMissing(url: string): Promise<boolean> {
  const board = greenhouseBoardFromUrl(url)
  if (!board) return false
  try {
    const response = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs/${encodeURIComponent(board.jobId)}`,
      { signal: AbortSignal.timeout(8_000) },
    )
    return response.status === 404
  } catch {
    return false
  }
}

export async function loadGreenhouseFormSchema(url: string): Promise<GreenhouseSchemaLoad> {
  const board = greenhouseBoardFromUrl(url)
  if (!board) return { status: 'skip' }
  try {
    const response = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs/${encodeURIComponent(board.jobId)}?questions=true`,
      { signal: AbortSignal.timeout(10_000) },
    )
    if (response.status === 404) return { status: 'missing' }
    if (!response.ok) return { status: 'skip' }
    const payload = (await response.json()) as GreenhouseJobQuestions
    return { status: 'ok', fields: collectSchemaFields(payload) }
  } catch {
    return { status: 'skip' }
  }
}

export function mergeGreenhouseSchema(fields: FormField[], schema: GreenhouseSchemaField[]): FormField[] {
  if (!schema.length) return fields
  return fields.map((field) => {
    if (field.options?.length) return field
    const match = findSchemaField(field.label, schema)
    if (!match?.options.length) return field
    return { ...field, options: match.options }
  })
}

export function collectSchemaFields(payload: GreenhouseJobQuestions): GreenhouseSchemaField[] {
  const out: GreenhouseSchemaField[] = []
  const pushQuestion = (question: GreenhouseApiQuestion) => {
    const label = question.label?.trim()
    if (!label) return
    const apiFields = (question.fields ?? []).filter((field) => field.type !== 'input_file' && field.type !== 'input_hidden')
    if (!apiFields.length) return
    const options = apiFields.flatMap((field) => (field.values ?? []).map((value) => value.label?.trim() ?? '').filter(Boolean))
    const name = apiFields[0]?.name
    out.push({ label, required: Boolean(question.required), ...(name ? { name } : {}), options })
  }
  for (const question of payload.questions ?? []) pushQuestion(question)
  for (const question of payload.location_questions ?? []) pushQuestion(question)
  for (const block of payload.compliance ?? []) {
    for (const question of block.questions ?? []) pushQuestion(question)
  }
  for (const question of payload.demographic_questions?.questions ?? []) {
    const label = question.label?.trim()
    if (!label) continue
    const options = (question.answer_options ?? []).map((option) => option.label?.trim() ?? '').filter(Boolean)
    out.push({ label, required: Boolean(question.required), options })
  }
  return out
}

function findSchemaField(label: string, schema: GreenhouseSchemaField[]): GreenhouseSchemaField | undefined {
  const key = foldKey(label)
  const exact = schema.find((row) => foldKey(row.label) === key)
  if (exact) return exact
  const contained = schema.filter((row) => {
    const other = foldKey(row.label)
    if (other.length < 10 || key.length < 10) return false
    return other.includes(key) || key.includes(other)
  })
  return contained.length === 1 ? contained[0] : undefined
}

function foldKey(label: string): string {
  return label
    .replace(/[\u2731\u066D\uFF0A*†‡]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
