export const PROVIDER_SPAM_MESSAGE = 'The provider rejected this submission as possible spam. This is not a missing-answer issue. Automatic retry is disabled; contact the provider to resolve the block.'
/** Detect an explicit post-submit rejection, not a job description discussing spam. */
export function providerSubmissionBlocked(body:string):boolean {
 return /we\s+(?:couldn['’]t|could\s+not)\s+submit\s+your\s+application/i.test(body)
  && /your\s+application\s+submission\s+was\s+flagged\s+as\s+possible\s+spam/i.test(body)
}

/** Visible ATS validation after a click. The application was not accepted. */
export function providerValidationFailed(body:string):boolean {
 return /your form needs corrections/i.test(body)
  || /missing entry for required field/i.test(body)
  || /\bthis field is required\b/i.test(body)
  || /please (?:complete|correct|fix) (?:the|this|all) (?:required )?fields?/i.test(body)
  || /verification code was sent/i.test(body)
  || /enter the \d[- ]?character code/i.test(body)
  || /8-character code/i.test(body)
  || /security code to confirm you/i.test(body)
  || /confirm you(?:['’]re| are) a human/i.test(body)
  || /error processing your application/i.test(body)
}
