/**
 * Why an attempt ended without a confirmed submission.
 *
 * Production data showed one bucket — `needs_review` — absorbing a missing
 * answer, a dropped browser connection, a model outage and a validation miss
 * alike. Nothing could retry itself and nobody could rank what to fix. Every
 * terminal attempt now carries exactly one of these.
 */
export type FailureClass =
  /** Infrastructure blip before any submit click: retry automatically. */
  | 'transient'
  /** A required question has no safe answer: ask the user, then resume. */
  | 'needs_answer'
  /** The posting is gone. Not a failure of ours; never retried. */
  | 'posting_closed'
  /** Account wall, unknown portal or listing page with no form: route to manual. */
  | 'unsupported'
  /** A submit click happened and its result is unknown: verify, never blind-retry. */
  | 'uncertain_submit'
  /** The provider explicitly rejected the submission (spam flag). Terminal. */
  | 'provider_rejected'
  /** The form could not be completed by automation (field would not commit). */
  | 'automation'
  /** Configuration or account problem on our side (model credits, auth). */
  | 'internal'
  /** Browser lane busy; nothing ran. Kept only for historical rows. */
  | 'deferred'

export const MAX_TRANSIENT_RETRIES = 3

/** Backoff for the Nth automatic retry (0-based): 1, 5, then 15 minutes. */
export function retryDelayMs(retryIndex: number): number {
  return [60_000, 5 * 60_000, 15 * 60_000][Math.max(0, Math.min(2, retryIndex))]!
}

export function shouldAutoRetry(failure: FailureClass, submitAttempted: boolean, retryIndex: number): boolean {
  return failure === 'transient' && !submitAttempted && retryIndex < MAX_TRANSIENT_RETRIES
}

const TRANSIENT = [
  /\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|\bEPIPE\b|\bEAI_AGAIN\b|socket hang up/i,
  /net::ERR_(?:TIMED_OUT|CONNECTION|NETWORK|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ABORTED|EMPTY_RESPONSE|HTTP2)/i,
  /Target (?:page, context or browser|closed)|browser has been closed|Browser closed|has been disconnected|Session closed/i,
  /Navigation timeout|page\.goto: Timeout|Timeout \d+ms exceeded/i,
  /Application lease lost|lane renewal/i,
  /Cannot reach the browser host|browser host returned 5\d\d|did not become ready|Chrome exited|Chrome debugging endpoint/i,
  /\bHTTP (?:429|5\d\d)\b|rate.?limit|overloaded|temporarily unavailable|Service Unavailable|Bad Gateway|Gateway Timeout/i,
  /job stalled more than allowable limit/i,
  /Execution context was destroyed|frame was detached/i,
]

const INTERNAL = [
  /no available credits|credits are unavailable|insufficient[_ ]quota|billing/i,
  /authentication failed|invalid api key|401 unauthorized|rejected our credentials/i,
  /is not set\. Model-backed features are disabled|not configured/i,
]

/** Classify a thrown error. A submit attempt always wins over the message. */
export function classifyError(error: unknown, context: { submitAttempted: boolean }): FailureClass {
  if (context.submitAttempted) return 'uncertain_submit'
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (name === 'ModelBudgetExceededError') return 'internal'
  if (INTERNAL.some((pattern) => pattern.test(message))) return 'internal'
  if (name === 'TimeoutError' || name === 'AbortError') return 'transient'
  if (name === 'ModelServiceUnavailableError') return 'transient'
  if (TRANSIENT.some((pattern) => pattern.test(message))) return 'transient'
  // Unknown errors are usually deterministic bugs; retrying them only repeats them.
  return 'automation'
}

/** Map a blocked reason recorded by a driver onto the taxonomy. */
export function classifyBlockedReason(reason: string | null | undefined): FailureClass {
  switch (reason) {
    case 'posting_closed':
      return 'posting_closed'
    case 'no_form':
    case 'login_required':
    case 'captcha':
    case 'unsupported':
      return 'unsupported'
    case 'provider_blocked':
      return 'provider_rejected'
    case 'needs_input':
    case 'unknown_field':
    case 'sensitive_field':
    case 'needs_answer':
      return 'needs_answer'
    case 'automation_limit':
    case 'field_rejected':
    case 'invalid_fields':
      return 'automation'
    default:
      return 'automation'
  }
}

/** Short, user-facing explanation per class, shown beside the application. */
export const FAILURE_COPY: Record<FailureClass, string> = {
  transient: 'A temporary browser or network problem interrupted this application. It will retry automatically.',
  needs_answer: 'This application needs an answer from you before it can continue.',
  posting_closed: 'This posting is no longer accepting applications.',
  unsupported: 'This site needs a manual application (sign-in, account, or no application form).',
  uncertain_submit: 'Submit was clicked but the result could not be confirmed. We will check for a confirmation email; do not resubmit until then.',
  provider_rejected: 'The employer’s system rejected this submission. Automatic retry is disabled.',
  automation: 'Automation could not complete a field on this form. Review the evidence and finish it manually or retry.',
  internal: 'A configuration problem on our side stopped this application. It has not been submitted.',
  deferred: 'The browser was busy; nothing was attempted.',
}
