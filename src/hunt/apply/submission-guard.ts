import { AsyncLocalStorage } from 'node:async_hooks'

const submissionScope = new AsyncLocalStorage<{ before: () => Promise<void>; attempted: boolean }>()
/** The browser callback is not invoked unless the irreversible intent is durable. */
export function withSubmissionGuard<T>(operation: () => Promise<T>, before: () => Promise<void>) {
  return submissionScope.run({before,attempted:false}, operation)
}
export async function beforeSubmission() {
  const scope = submissionScope.getStore()
  if (!scope) return // Other callers such as isolated fixtures own their own bookkeeping.
  if (scope.attempted) throw new Error('A submit was already attempted in this browser. Do not submit twice.')
  await scope.before()
  scope.attempted = true
}
export function submissionWasAttempted() { return submissionScope.getStore()?.attempted ?? false }

/** Unexpected provider confirmation after a step/choice is irreversible evidence too. */
export async function noteUnexpectedSubmission() {
  const scope=submissionScope.getStore()
  if(!scope||scope.attempted)return
  scope.attempted=true
  await scope.before()
}
