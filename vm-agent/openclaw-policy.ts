/** This contract contains form values, never credentials or arbitrary file paths. */
export const validAttemptId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
export function validateOpenClawPolicy(body: any, tenant: number, now = Date.now()): string | null {
  if (!body || !validAttemptId(body.attemptId)) return 'invalid_attempt'
  if (!/^[A-F0-9]{16,64}$/i.test(body.targetId ?? '') || !Number.isSafeInteger(body.deadlineEpoch) || body.deadlineEpoch <= now || body.deadlineEpoch > now + 660000) return 'invalid_policy_target_or_deadline'
  if (!Array.isArray(body.allowedHosts) || body.allowedHosts.length === 0 || body.allowedHosts.length > 30 || body.allowedHosts.some((host: unknown) => typeof host !== 'string' || !/^[a-z0-9.-]+$/.test(host) || host.includes('..'))) return 'invalid_policy_hosts'
  if (!Array.isArray(body.approvedFields) || body.approvedFields.length > 200 || body.approvedFields.some((f: any) => !f || typeof f.label !== 'string' || f.label.length > 4000 || typeof f.type !== 'string' || f.type.length > 100 || typeof f.value !== 'string' || f.value.length > 4000)) return 'invalid_policy_fields'
  if (body.resumePath !== null && body.resumePath !== `/home/huntly-u${tenant}/run/huntly-resume.pdf`) return 'invalid_resume_path'
  return null
}
