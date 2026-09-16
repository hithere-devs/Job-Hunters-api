import { saveApplyFields } from '../persona/apply-fields.js'
import { rememberAnswer, resolveField } from '../hunt/apply/fields.js'
import type { PortalProfile } from '../hunt/portal-profile.js'
import { draftForOwnedQuestion } from '../modules/applications/question-drafts.js'
/** Isolated transaction fixture. No provider login, mail delivery, or persisted test user. */
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { db, getPool, runWithDatabase } from '../db/client.js'
import { onboardingSubmissions, passwordResetTokens, users } from '../db/schema.js'
import { completeOnboarding } from '../modules/me/service.js'
import { refreshSession, signUp } from '../modules/auth/service.js'
import { resetPassword } from '../modules/auth/recovery.js'
import { hashToken, verifyAccessToken } from '../lib/jwt.js'
import { withBrowserLifecycle } from '../browser/lifecycle.js'

assert.equal(getPool().options.max, 1, 'Run with DATABASE_POOL_MAX=1 to exercise pool-starvation regression')
const rollback = new Error('fixture rollback')
try {
  await db.transaction((tx) => runWithDatabase(tx, async () => {
    const password = crypto.randomBytes(24).toString('base64url')
    const session = await signUp({ email: `auth-regression-${crypto.randomUUID()}@example.test`, name: 'Isolated auth fixture', password }, {})
    const userId = session.user.id
    await withBrowserLifecycle(userId, async () => {
      const [nested] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId))
      assert.equal(nested?.id, userId)
    })
    await completeOnboarding(userId, { roles: 'Engineer' })
    await completeOnboarding(userId, { roles: 'Overwrite attempt' })
    const submissions = await db.select().from(onboardingSubmissions).where(eq(onboardingSubmissions.userId, userId))
    assert.equal(submissions.length, 1)
    const fields = await saveApplyFields(userId, { expectedCtc: 'INR 2400000 per year', workAuthorization: 'Authorized to work in India' })
    assert.equal(fields.fields.find((field) => field.id === 'expectedCtc')?.value, 'INR 2400000 per year')
    const profile = {} as PortalProfile
    const context = { userId, host: 'jobs.example.test', profile }
    const salary = await resolveField({ label: 'Expected salary', type: 'text', required: true }, context)
    assert.equal(salary.value, 'INR 2400000 per year')
    const countryQuestion = await resolveField({ label: 'Are you legally authorized to work in the USA?', type: 'text', required: true }, context)
    assert.equal(countryQuestion.blocked, 'sensitive_field')
    const demographic = { label: 'Gender', type: 'select', required: false, options: ['Female', 'Male', 'Prefer not to say'] }
    await rememberAnswer(userId, context.host, demographic, 'Prefer not to say')
    assert.equal((await resolveField(demographic, context)).value, 'Prefer not to say')
    assert.equal((await resolveField(demographic, { ...context, userId: crypto.randomUUID() })).value, null)
    await assert.rejects(() => rememberAnswer(userId, context.host, { label: 'Password', type: 'password', required: true }, 'never-store-this'))
    await assert.rejects(() => draftForOwnedQuestion(userId, crypto.randomUUID()))
    console.log('PASS explicit answers: saved profile salary, no country inference, scoped opt-in reuse, other-user rejection, credential refusal, unknown question ownership rejection')
    const refreshed = await refreshSession(session.refreshToken, {})
    await assert.rejects(() => refreshSession(session.refreshToken, {}))
    const token = crypto.randomBytes(32).toString('base64url')
    await db.insert(passwordResetTokens).values({ userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60_000) })
    await resetPassword(token, crypto.randomBytes(24).toString('base64url'))
    await assert.rejects(() => resetPassword(token, password))
    await assert.rejects(() => refreshSession(refreshed.refreshToken, {}))
    const [user] = await db.select().from(users).where(eq(users.id, userId))
    assert.equal(user?.authVersion, verifyAccessToken(refreshed.accessToken).authVersion + 1)
    console.log('PASS poolMax=1: signup/serializer, lifecycle nested queries, onboarding retry, refresh one-use, reset one-use, refresh revocation, access authVersion')
    throw rollback
  }))
} catch (error) {
  if (error !== rollback) throw error
  console.log('PASS fixture transaction rolled back; no user retained')
} finally {
  await getPool().end()
}
