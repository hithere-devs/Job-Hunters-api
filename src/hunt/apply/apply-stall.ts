export const APPLY_STALL_MS = 30_000

export type StallMove = 'retry_same' | 'try_next' | 'wait' | 'click' | 'submit' | 'fail'

export function leftoverSignature(labels: string[]): string {
  return labels.map((label) => label.replace(/\s+/g, ' ').trim()).filter(Boolean).sort().join('|')
}

export function applyIsStalled(lastProgressAt: number, now = Date.now(), stallMs = APPLY_STALL_MS): boolean {
  return now - lastProgressAt >= stallMs
}

export function stallMoveFromJev(choice: string | null | undefined): StallMove {
  if (choice === 'try_next' || choice === 'wait' || choice === 'click' || choice === 'submit' || choice === 'fail') return choice
  return 'retry_same'
}

export function applyMadeProgress(params: {
  before: string
  after: string
  filledBefore: number
  filledAfter: number
}): boolean {
  return params.after !== params.before || params.filledAfter > params.filledBefore
}
