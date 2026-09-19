import { classifyApplyQuestion } from './apply-preferences.js'
import type { BlockedReason } from './state.js'
import type { PilotElement } from './pilot-page.js'

export type PilotTerminalKind = 'submitted' | 'can_submit' | 'verification' | 'needs_review' | 'no_form'

export interface PilotUnresolved {
  label: string
  type: string
  why: BlockedReason
}

const VERIFICATION = /verification code was sent|enter the \d[- ]?character code|8-character code|security code to confirm|confirm you(?:['’]re| are) a human|otp\b|one[- ]time code/i

export function pageHasVerificationGate(text: string): boolean {
  return VERIFICATION.test(text)
}

export function filterPilotUnresolved(elements: PilotElement[], why: BlockedReason = 'needs_input'): PilotUnresolved[] {
  const student = elements.find((element) => classifyApplyQuestion(element.label) === 'student')
  const studentNo = Boolean(student && /^(no|false)$/i.test(String(student.value || '').trim()))
  return elements
    .filter((element) => {
      if (!element.required || element.filled) return false
      if (element.role === 'file' || element.role === 'button' || element.role === 'link') return false
      if (studentNo && classifyApplyQuestion(element.label) === 'start_date') return false
      return true
    })
    .map((element) => ({ label: element.label, type: element.role, why }))
}

export function decidePilotTerminal(input: {
  leftover: PilotUnresolved[]
  confirmed: boolean
  verificationPending: boolean
  looksLikeForm: boolean
  filledCount: number
}): { kind: PilotTerminalKind; unresolved: PilotUnresolved[]; canSubmit: boolean; submitted: boolean } {
  if (input.confirmed) {
    return { kind: 'submitted', unresolved: [], canSubmit: true, submitted: true }
  }
  if (input.verificationPending) {
    return {
      kind: 'verification',
      unresolved: [{ label: 'Email verification code', type: 'automation', why: 'login_required' }],
      canSubmit: false,
      submitted: false,
    }
  }
  if (input.looksLikeForm || input.filledCount > 0) {
    return { kind: 'can_submit', unresolved: input.leftover, canSubmit: true, submitted: false }
  }
  if (input.leftover.length > 0) {
    return { kind: 'needs_review', unresolved: input.leftover, canSubmit: false, submitted: false }
  }
  return {
    kind: 'no_form',
    unresolved: [{ label: 'This page is a job listing or error page, not an application form.', type: 'automation', why: 'no_form' }],
    canSubmit: false,
    submitted: false,
  }
}
