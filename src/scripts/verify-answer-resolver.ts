/** Real, metered configured-provider call using synthetic facts only; no user profile or provider login. */
import assert from 'node:assert/strict'
import { and, eq, gte, isNull } from 'drizzle-orm'
import { db, getPool } from '../db/client.js'
import { modelUsage } from '../db/schema.js'
import { ANSWER_RESOLVER_MODEL, resolveAnswerBatch, type AnswerSource, type ResolverQuestion } from '../persona/answer-resolver.js'
const startedAt = new Date()
const base = { applicationId: 'synthetic-app', required: true, role: 'Engineer', company: 'FixtureCo', location: 'United States' }
const questions: ResolverQuestion[] = [
  { ...base, id: 'network', label: 'Please provide your professional networking profile URL', type: 'text' },
  { ...base, id: 'us', label: 'Will you require sponsorship to work in the United States?', type: 'select', options: ['Yes', 'No'] },
  { ...base, id: 'uk', label: 'Will you require sponsorship to work in the United Kingdom?', location: 'United Kingdom', type: 'select', options: ['Yes', 'No'] },
]
const sources: AnswerSource[] = [
  { id: 'profile:linkedin', label: 'LinkedIn profile URL', text: 'https://www.linkedin.com/in/example-candidate', kind: 'profile', topic: 'contact' },
  { id: 'user:sponsorship', label: 'Will you require employment sponsorship?', text: 'For India no, for USA yes', kind: 'explicit_answer', topic: 'sponsorship' },
]
try {
  const results = await resolveAnswerBatch({ userId: null, questions, sources })
  console.log(JSON.stringify({ model: ANSWER_RESOLVER_MODEL, results: results.map(({ questionId, decision, autoApply, reason }) => ({ questionId, decision, autoApply, reason })) }))
  assert.equal(results.find((answer) => answer.questionId === 'network')?.answer, sources[0]!.text)
  assert.equal(results.find((answer) => answer.questionId === 'network')?.autoApply, true)
  assert.equal(results.find((answer) => answer.questionId === 'us')?.answer, 'Yes')
  assert.equal(results.find((answer) => answer.questionId === 'us')?.autoApply, true)
  assert.equal(results.find((answer) => answer.questionId === 'uk')?.decision, 'ask')
  const calls = await db.select({ model: modelUsage.model, ok: modelUsage.ok }).from(modelUsage).where(and(eq(modelUsage.model, ANSWER_RESOLVER_MODEL), isNull(modelUsage.userId), gte(modelUsage.createdAt, startedAt)))
  assert.ok(calls.some((call) => call.ok), 'A successful metered call to the requested model must exist')
  console.log(`PASS actual ${ANSWER_RESOLVER_MODEL}: LinkedIn wording resolved, conditional US sponsorship resolved, unknown UK sponsorship not inferred; successful metered calls=${calls.filter((call) => call.ok).length}`)
} finally { await getPool().end() }
