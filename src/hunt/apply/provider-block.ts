export const PROVIDER_SPAM_MESSAGE = 'The provider rejected this submission as possible spam. This is not a missing-answer issue. Automatic retry is disabled; contact the provider to resolve the block.'
/** Detect an explicit post-submit rejection, not a job description discussing spam. */
export function providerSubmissionBlocked(body:string):boolean {
 return /we\s+(?:couldn['’]t|could\s+not)\s+submit\s+your\s+application/i.test(body)
  && /your\s+application\s+submission\s+was\s+flagged\s+as\s+possible\s+spam/i.test(body)
}
