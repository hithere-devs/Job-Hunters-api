import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { nudgeRun } from '../../browser/openclaw-client.js'
import { getRedis } from '../../lib/redis.js'

export const nudgeMessageSchema = z.string().trim().min(1).max(2000).refine(
  value => !/\b(password|passwd|otp|one[- ]time[- ](?:password|code)|verification code|captcha|bearer|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token)\b|-----BEGIN .*PRIVATE KEY-----|\b(?:sk|AIza)[-_A-Za-z0-9]{16,}/i.test(value),
  'Do not send passwords, login codes, CAPTCHA answers or secret tokens. Sign in through browser setup instead.',
)
const commandSchema = z.object({ id: z.string().uuid(), attemptId: z.string().uuid(), message: nudgeMessageSchema, expiresAt: z.number().int() }).strict()
export const openClawNudgeChannel = (attemptId: string) => `huntly:openclaw:nudge:${attemptId}`

/** Runner-owned subscription. It never starts an agent, extends a deadline, or logs a message. */
export async function subscribeOpenClawNudges(input: {
  attemptId: string
  runId: string
  deadlineAt: number
  onStatus?: (status: 'nudge_accepted' | 'nudge_rejected') => void | Promise<void>
}): Promise<() => void> {
  const subscriber = getRedis().duplicate({ lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 3000 })
  const seen = new Set<string>()
  let stopped = false
  const report = (status: 'nudge_accepted' | 'nudge_rejected') => { void Promise.resolve(input.onStatus?.(status)).catch(() => undefined) }
  subscriber.on('error', () => { /* No raw command or token enters logs. API detects absence. */ })
  subscriber.on('message', (channel, raw) => {
    if (stopped || channel !== openClawNudgeChannel(input.attemptId) || raw.length > 9000) return
    let payload: unknown
    try { payload = JSON.parse(raw) } catch { return }
    const parsed = commandSchema.safeParse(payload)
    if (!parsed.success || parsed.data.attemptId !== input.attemptId || seen.has(parsed.data.id)) return
    if (Date.now() >= input.deadlineAt || Date.now() >= parsed.data.expiresAt || seen.size >= 8) { report('nudge_rejected'); return }
    seen.add(parsed.data.id)
    void nudgeRun(input.runId, parsed.data.message).then(() => report('nudge_accepted'), () => report('nudge_rejected'))
  })
  try { await subscriber.connect(); await subscriber.subscribe(openClawNudgeChannel(input.attemptId)) }
  catch (error) { subscriber.disconnect(); throw error }
  const cleanup = () => { if (stopped) return; stopped = true; clearTimeout(timer); subscriber.disconnect() }
  const timer = setTimeout(cleanup, Math.max(1, input.deadlineAt - Date.now()))
  return cleanup
}

export function createNudgeCommand(attemptId: string, message: string) {
  return commandSchema.parse({ id: randomUUID(), attemptId, message, expiresAt: Date.now() + 15_000 })
}
