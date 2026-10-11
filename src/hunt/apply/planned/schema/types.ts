/**
 * One application form, described independently of how it renders.
 *
 * The ATS's own definition is the source of truth wherever one is published:
 * exact question text, which questions are required, and the exact option
 * labels. DOM heuristics guessed all three and were wrong often enough to be
 * the largest single failure source (forms submitted with required fields the
 * reader did not know were required).
 */

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'email'
  | 'phone'
  | 'url'
  | 'number'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'checkbox'
  | 'file'
  | 'location'

export interface FieldOption {
  label: string
  value?: string
}

export type FieldSection = 'profile' | 'question' | 'eeo' | 'consent' | 'location'

export interface SchemaField {
  /** Stable within one form: `gh:<field name>`, `ashby:<path>`, `dom:<element id>`. */
  key: string
  label: string
  description?: string
  kind: FieldKind
  required: boolean
  options: FieldOption[]
  /** The ATS's own identifier; the DOM usually carries it as an id or name. */
  atsName?: string
  section: FieldSection
  fileRole?: 'resume' | 'cover_letter' | 'other'
  /** Present on DOM-derived fields: the element id stamped by the page script. */
  domId?: string
}

export type SchemaSource = 'greenhouse' | 'ashby' | 'dom'

export interface FormSchema {
  source: SchemaSource
  /** The URL whose form this describes. */
  url: string
  fields: SchemaField[]
  /** The ATS says the posting no longer exists. */
  closed?: boolean
  title?: string
  company?: string
  /** Stable hash of the field definitions, for plan caching. */
  fingerprint: string
}
