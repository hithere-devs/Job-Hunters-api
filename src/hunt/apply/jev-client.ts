import { env, hasJev } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { recordUsage } from '../../model/meter.js'

export type JevNoul = { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
export type JevChoice = { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
export type JevScore = { type: 'score'; instructions: string; criteria: string[] }
export type JevQuestion = JevNoul | JevChoice | JevScore

export interface JevNoulAnswer {
  type: 'noul'
  noul: number
}
export interface JevChoiceAnswer {
  type: 'choice'
  choice: string
  probabilities?: Record<string, number>
  confidence?: number
}
export interface JevScoreAnswer {
  type: 'score'
  score: number
  confidence?: number
}
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer

export interface JevResponse {
  model: string
  answers: Record<string, JevAnswer>
  usage?: { input_tokens?: number; output_tokens?: number }
}

export class JevUnavailableError extends Error {
  constructor(message = 'Jev is not configured. Set TYPESAFE_API_KEY.') {
    super(message)
    this.name = 'JevUnavailableError'
  }
}

export interface JevDecideParams {
  state: unknown
  questions: Record<string, JevQuestion>
  userId?: string | null
  signal?: AbortSignal
  fetch?: typeof fetch
  record?: typeof recordUsage
  apiKey?: string
}

function noul(answer: JevAnswer | undefined): number {
  return answer?.type === 'noul' ? answer.noul : 0
}
function choice(answer: JevAnswer | undefined): string | null {
  return answer?.type === 'choice' ? answer.choice : null
}

export const jevRead = { noul, choice }

export async function jevDecide(params: JevDecideParams): Promise<JevResponse> {
  const apiKey = params.apiKey ?? env.TYPESAFE_API_KEY
  if (!apiKey && !hasJev) throw new JevUnavailableError()
  if (!apiKey) throw new JevUnavailableError()
  const fetchRequest = params.fetch ?? fetch
  const record = params.record ?? recordUsage
  const body = {
    model: env.JEV_MODEL,
    state: params.state,
    questions: params.questions,
  }
  const startedAt = Date.now()
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const signal = params.signal
        ? AbortSignal.any([params.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000)
      const response = await fetchRequest(`${env.TYPESAFE_API_BASE.replace(/\/$/, '')}/v1/systemone`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      })
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`Jev HTTP ${response.status}`)
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
        continue
      }
      const data = await response.json() as JevResponse & { error?: { message?: string } }
      if (!response.ok || data.error) {
        throw new Error(`Jev request rejected (HTTP ${response.status}).`)
      }
      if (!data.answers || typeof data.answers !== 'object') {
        throw new Error('Jev returned no answers.')
      }
      await record({
        userId: params.userId ?? null,
        purpose: 'apply-jev',
        model: data.model || env.JEV_MODEL,
        usage: {
          input_tokens: data.usage?.input_tokens ?? 0,
          output_tokens: data.usage?.output_tokens ?? 0,
        },
        durationMs: Date.now() - startedAt,
        ok: true,
      })
      return data
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (params.signal?.aborted) throw lastError
      if (attempt < 2 && /HTTP 429|HTTP 5/.test(lastError.message)) {
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
        continue
      }
      await record({
        userId: params.userId ?? null,
        purpose: 'apply-jev',
        model: env.JEV_MODEL,
        usage: undefined,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: lastError.name,
      }).catch(() => undefined)
      logger.warn({ err: lastError }, 'Jev decide failed')
      throw lastError
    }
  }
  throw lastError ?? new Error('Jev request failed')
}
