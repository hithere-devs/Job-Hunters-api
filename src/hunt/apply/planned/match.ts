import type { PilotElement } from '../pilot-page.js'
import { foldLabel } from './schema/fingerprint.js'
import type { FieldKind, SchemaField } from './schema/types.js'

/**
 * Pair each schema field with the element on the page that renders it.
 *
 * ATS identifiers first (Greenhouse renders `question_123` as the input id,
 * Ashby uses the field path as the name), then exact label, then containment,
 * then token overlap. Each element is used once.
 */

const COMPATIBLE: Record<FieldKind, string[]> = {
  text: ['textbox', 'text', 'email', 'tel', 'url', 'number', 'combobox', 'textarea'],
  textarea: ['textarea', 'textbox', 'text'],
  email: ['email', 'textbox', 'text'],
  phone: ['tel', 'textbox', 'text', 'number'],
  url: ['url', 'textbox', 'text'],
  number: ['number', 'textbox', 'text'],
  date: ['date', 'textbox', 'text', 'combobox'],
  select: ['select', 'combobox', 'radio', 'yesno', 'checkbox'],
  multiselect: ['checkbox', 'combobox', 'select'],
  boolean: ['yesno', 'radio', 'select', 'combobox', 'checkbox'],
  checkbox: ['checkbox'],
  file: ['file'],
  location: ['combobox', 'textbox', 'text'],
}

function tokens(value: string): string[] {
  return foldLabel(value).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((token) => token.length > 2)
}

export function matchScore(field: SchemaField, element: PilotElement): number {
  if (!COMPATIBLE[field.kind]?.includes(element.role)) return 0
  if (field.domId && field.domId === element.id) return 1_000
  const hints = [element.name, ...(element.hints ?? [])].filter((hint): hint is string => Boolean(hint))
  if (field.atsName) {
    const name = field.atsName
    if (hints.some((hint) => hint === name || hint === `${name}[]` || hint.endsWith(`[${name}]`) || hint === `${name}-input`)) return 500
    if (name.length >= 8 && hints.some((hint) => hint.includes(name))) return 400
  }
  const want = foldLabel(field.label)
  const have = foldLabel(element.label)
  if (!want || !have) return 0
  if (want === have) return 300
  if (want.length >= 10 && have.length >= 10 && (have.startsWith(want) || want.startsWith(have))) return 240
  if (want.length >= 12 && have.length >= 12 && (have.includes(want) || want.includes(have))) return 200
  const a = new Set(tokens(want))
  const b = new Set(tokens(have))
  if (!a.size || !b.size) return 0
  const shared = [...a].filter((token) => b.has(token)).length
  const jaccard = shared / (a.size + b.size - shared)
  return jaccard >= 0.6 ? Math.round(100 + jaccard * 80) : 0
}

export interface FieldMatch {
  field: SchemaField
  element: PilotElement | null
  score: number
}

export function matchFields(fields: SchemaField[], elements: PilotElement[]): FieldMatch[] {
  const candidates: Array<{ field: SchemaField; element: PilotElement; score: number }> = []
  for (const field of fields) {
    for (const element of elements) {
      const score = matchScore(field, element)
      if (score > 0) candidates.push({ field, element, score })
    }
  }
  candidates.sort((left, right) => right.score - left.score)
  const usedFields = new Set<string>()
  const usedElements = new Set<string>()
  const chosen = new Map<string, FieldMatch>()
  for (const candidate of candidates) {
    if (usedFields.has(candidate.field.key) || usedElements.has(candidate.element.id)) continue
    usedFields.add(candidate.field.key)
    usedElements.add(candidate.element.id)
    chosen.set(candidate.field.key, candidate)
  }
  return fields.map((field) => chosen.get(field.key) ?? { field, element: null, score: 0 })
}

/** Required inputs on the page that no schema field claimed: conditional or unpublished questions. */
export function unclaimedRequired(elements: PilotElement[], matches: FieldMatch[]): PilotElement[] {
  const claimed = new Set(matches.map((match) => match.element?.id).filter(Boolean))
  return elements.filter((element) =>
    element.required
    && !claimed.has(element.id)
    && !['button', 'link'].includes(element.role)
    && !/^phone country code$/i.test(element.label))
}
