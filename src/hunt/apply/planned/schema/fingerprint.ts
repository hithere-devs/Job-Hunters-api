import crypto from 'node:crypto'
import type { SchemaField } from './types.js'

export function schemaFingerprint(fields: SchemaField[]): string {
  const canonical = fields
    .map((field) => [field.key, field.label, field.kind, field.required, field.options.map((option) => option.label).join('|')].join('\u0001'))
    .join('\u0002')
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24)
}

export function foldLabel(value: string): string {
  return String(value ?? '')
    .replace(/[✱٭＊*†‡]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Strip HTML from ATS descriptions without a parser dependency. */
export function htmlToText(html: string | null | undefined): string {
  return String(html ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}
