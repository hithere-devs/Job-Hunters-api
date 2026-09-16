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
