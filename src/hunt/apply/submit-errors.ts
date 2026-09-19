import type { PilotElement } from './pilot-page.js'

/** Visible validation copy after a submit click. */
export function extractPageErrors(text: string): string {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 4 && /required|please (?:select|complete|fill|choose|fix)|this field|error processing|invalid|must (?:select|complete|fill)|missing/i.test(line))
    .slice(0, 10)
    .join('\n')
}

export function fieldMatchingError(errorText: string, elements: Array<{ id: string; label: string }>): string | null {
  const blob = String(errorText ?? '').toLowerCase()
  if (!blob || !elements.length) return null
  let best: { id: string; score: number } | null = null
  for (const element of elements) {
    const label = element.label.toLowerCase()
    let score = 0
    if (blob.includes(label.slice(0, 40))) score += 8
    for (const word of label.split(/[^a-z0-9]+/).filter((token) => token.length > 3)) {
      if (blob.includes(word)) score += 1
    }
    if (!best || score > best.score) best = { id: element.id, score }
  }
  return best && best.score >= 2 ? best.id : null
}

export function fieldsToRepairAfterSubmit(params: {
  pageText: string
  elements: PilotElement[]
}): PilotElement[] {
  const leftover = params.elements.filter((element) => {
    if (element.role === 'button' || element.role === 'link' || element.role === 'file') return false
    if (!element.required && element.filled) return false
    return !element.filled
  })
  const errors = extractPageErrors(params.pageText)
  const matched = fieldMatchingError(errors || params.pageText, leftover)
  if (matched) {
    const hit = leftover.find((element) => element.id === matched)
    if (hit) return [hit, ...leftover.filter((element) => element.id !== matched)]
  }
  return leftover
}
