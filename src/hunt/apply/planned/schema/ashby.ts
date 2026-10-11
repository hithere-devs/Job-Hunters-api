import { htmlToText, schemaFingerprint } from './fingerprint.js'
import type { FieldKind, FormSchema, SchemaField } from './types.js'

/**
 * Ashby renders its hosted form from the same GraphQL document its own page
 * requests (`ApiJobPosting`). It carries every field's path (the DOM uses it
 * as the input name), type, required flag and selectable values, plus the
 * EEOC survey as `surveyForms`.
 */

export interface AshbyRef { org: string; jobId: string }

export function ashbyRefFromUrl(url: string): AshbyRef | null {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname.toLowerCase().endsWith('ashbyhq.com')) return null
    const match = parsed.pathname.match(/^\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
    if (!match) return null
    return { org: decodeURIComponent(match[1]!), jobId: match[2]!.toLowerCase() }
  } catch {
    return null
  }
}

export function ashbyApplicationUrl(url: string): string | null {
  const ref = ashbyRefFromUrl(url)
  return ref ? `https://jobs.ashbyhq.com/${encodeURIComponent(ref.org)}/${ref.jobId}/application` : null
}

interface AshbyField {
  path?: string
  title?: string
  type?: string
  isNullable?: boolean
  selectableValues?: Array<{ label?: string; value?: string }>
}
interface AshbyEntry { id?: string; field?: AshbyField; isRequired?: boolean; descriptionHtml?: string | null; isHidden?: boolean | null }
interface AshbySection { title?: string | null; fieldEntries?: AshbyEntry[]; isHidden?: boolean | null }
interface AshbyForm { sections?: AshbySection[] }
export interface AshbyPostingPayload {
  data?: { jobPosting?: { id?: string; title?: string; isListed?: boolean; applicationForm?: AshbyForm | null; surveyForms?: AshbyForm[] | null } | null }
  errors?: Array<{ message?: string }>
}

const QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id title isListed
    applicationForm { ...FormRenderParts }
    surveyForms { ...FormRenderParts }
  }
}
fragment FormRenderParts on FormRender {
  id
  sections { title descriptionHtml isHidden fieldEntries { ... on FormFieldEntry { id field isRequired descriptionHtml isHidden } } }
}`

function kindOf(field: AshbyField): FieldKind {
  const title = String(field.title ?? '')
  switch (field.type) {
    case 'Email': return 'email'
    case 'Phone': return 'phone'
    case 'LongText': return 'textarea'
    case 'File': return 'file'
    case 'Boolean': return 'boolean'
    case 'ValueSelect': return 'select'
    case 'MultiValueSelect': return 'multiselect'
    case 'Location': return 'location'
    case 'Date': return 'date'
    case 'Number': return 'number'
    case 'SocialLink':
    case 'Url': return 'url'
    default:
      if (/linkedin|github|portfolio|website|\burl\b/i.test(title)) return 'url'
      return 'text'
  }
}

export function parseAshbyPayload(payload: AshbyPostingPayload, url: string): FormSchema {
  const posting = payload.data?.jobPosting
  if (!posting) return { source: 'ashby', url, fields: [], closed: true, fingerprint: 'closed' }
  const fields: SchemaField[] = []
  const add = (form: AshbyForm | null | undefined, survey: boolean) => {
    for (const section of form?.sections ?? []) {
      if (section.isHidden) continue
      for (const entry of section.fieldEntries ?? []) {
        const field = entry.field
        const path = String(field?.path ?? '')
        const label = String(field?.title ?? '').trim()
        if (!field || !path || !label || entry.isHidden) continue
        const kind = kindOf(field)
        const description = entry.descriptionHtml ? htmlToText(entry.descriptionHtml).slice(0, 600) : undefined
        const options = kind === 'boolean'
          ? [{ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' }]
          : (field.selectableValues ?? []).map((value) => ({ label: String(value.label ?? '').trim(), ...(value.value ? { value: value.value } : {}) })).filter((option) => option.label)
        const profile = path.startsWith('_systemfield_')
        fields.push({
          key: `ashby:${path}`,
          label,
          ...(description ? { description } : {}),
          kind,
          required: Boolean(entry.isRequired),
          options,
          atsName: path,
          section: survey ? 'eeo' : profile ? 'profile' : kind === 'location' ? 'location' : 'question',
          ...(kind === 'file' ? { fileRole: path === '_systemfield_resume' || /resume|cv\b/i.test(label) ? 'resume' as const : /cover/i.test(label) ? 'cover_letter' as const : 'other' as const } : {}),
        })
      }
    }
  }
  add(posting.applicationForm, false)
  for (const survey of posting.surveyForms ?? []) add(survey, true)
  return { source: 'ashby', url, fields, ...(posting.title ? { title: posting.title } : {}), fingerprint: schemaFingerprint(fields) }
}

export async function loadAshbySchema(url: string, fetchImpl: typeof fetch = fetch): Promise<FormSchema | null> {
  const ref = ashbyRefFromUrl(url)
  if (!ref) return null
  const response = await fetchImpl('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ operationName: 'ApiJobPosting', variables: { organizationHostedJobsPageName: ref.org, jobPostingId: ref.jobId }, query: QUERY }),
    signal: AbortSignal.timeout(12_000),
  })
  if (!response.ok) throw new Error(`Ashby posting API returned HTTP ${response.status}`)
  const payload = (await response.json()) as AshbyPostingPayload
  if (payload.errors?.length && !payload.data?.jobPosting) throw new Error(`Ashby posting API error: ${payload.errors[0]?.message ?? 'unknown'}`)
  return parseAshbyPayload(payload, ashbyApplicationUrl(url) ?? url)
}
