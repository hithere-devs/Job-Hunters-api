/** Infrastructure failures are not questions the applicant can answer. */
export class ModelServiceUnavailableError extends Error {
  constructor(readonly reason: 'provider_quota' | 'provider_auth') {
    super(reason === 'provider_quota'
      ? 'The AI model provider has no available credits or quota. Restore provider access or configure another model; your saved answers are unchanged.'
      : 'AI model provider authentication failed. Configure provider access; you do not need to sign into job accounts again.')
    this.name = 'ModelServiceUnavailableError'
  }
}
export function modelServiceFailure(error: unknown): ModelServiceUnavailableError | null {
  if(error instanceof ModelServiceUnavailableError)return error
  const message=typeof error==='string'?error:error instanceof Error?error.message:error&&typeof error==='object'&&'message' in error&&typeof error.message==='string'?error.message:''
  if(/credit balance.{0,60}too low|insufficient[_\s-]*(?:credits?|funds|quota)|exceeded.{0,30}current quota|billing[_\s-]*hard[_\s-]*limit/i.test(message))return new ModelServiceUnavailableError('provider_quota')
  if(/invalid.{0,20}api.?key|api.?key.{0,30}(?:invalid|expired)|invalid x-api-key|authentication_error/i.test(message))return new ModelServiceUnavailableError('provider_auth')
  return null
}
