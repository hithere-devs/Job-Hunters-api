import type { PilotElement, PilotSnapshot } from '../../pilot-page.js'
import { schemaFingerprint } from './fingerprint.js'
import type { FieldKind, FormSchema, SchemaField } from './types.js'

/**
 * A schema read from the rendered page, for forms whose ATS publishes none
 * (Lever, SmartRecruiters, Workable, custom career sites) and for fields an ATS
 * schema omits (conditional questions, phone country widgets).
 */

const FIELD_ROLES = new Set(['textbox', 'text', 'textarea', 'email', 'tel', 'url', 'number', 'date', 'combobox', 'select', 'radio', 'checkbox', 'yesno', 'file'])

export function kindForElement(element: PilotElement): FieldKind {
  switch (element.role) {
    case 'textarea': return 'textarea'
    case 'email': return 'email'
    case 'tel': return 'phone'
    case 'url': return 'url'
    case 'number': return 'number'
    case 'date': return 'date'
    case 'file': return 'file'
    case 'yesno': return 'boolean'
    case 'select': return 'select'
    case 'radio': return element.options.length === 2 && element.options.every((option) => /^(yes|no)$/i.test(option.trim())) ? 'boolean' : 'select'
    case 'checkbox': return element.options.length > 1 ? 'multiselect' : 'checkbox'
    case 'combobox': return /\b(?:location|city|where are you (?:currently )?(?:based|located))\b/i.test(element.label) && !element.options.length ? 'location' : 'select'
    default: return 'text'
  }
}

export function fieldFromElement(element: PilotElement): SchemaField | null {
  if (!FIELD_ROLES.has(element.role)) return null
  if (/^phone country code$/i.test(element.label)) return null
  const kind = kindForElement(element)
  return {
    key: `dom:${element.id}`,
    label: element.label,
    kind,
    required: element.required,
    options: element.options.map((label) => ({ label })),
    domId: element.id,
    ...(element.name ? { atsName: element.name } : {}),
    section: kind === 'file' ? 'profile' : 'question',
    ...(kind === 'file' ? { fileRole: /cover/i.test(element.label) ? 'cover_letter' as const : /resume|cv\b/i.test(element.label) || !/cover/i.test(element.label) ? 'resume' as const : 'other' as const } : {}),
  }
}

export function schemaFromSnapshot(snapshot: PilotSnapshot, url: string): FormSchema {
  const fields = snapshot.elements.map(fieldFromElement).filter((field): field is SchemaField => field !== null)
  return { source: 'dom', url, fields, fingerprint: schemaFingerprint(fields) }
}
