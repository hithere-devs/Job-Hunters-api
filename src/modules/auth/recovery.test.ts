import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { recoveryLink } from './recovery.js'
import { forgotPasswordSchema, resetPasswordSchema } from './schemas.js'
import { signAccessToken, verifyAccessToken } from '../../lib/jwt.js'

describe('password recovery security policy', () => {
  it('puts reset tokens only in a fragment, not request URLs', () => {
    const url = new URL(recoveryLink('https://app.example/reset-password', 'secret'))
    assert.equal(url.search, '')
    assert.equal(url.hash, '#token=secret')
    assert.equal(url.pathname, '/reset-password')
  })
  it('normalizes email and requires high-entropy token shape plus password policy', () => {
    assert.equal(forgotPasswordSchema.parse({ email: ' Test@Example.com ' }).email, 'test@example.com')
    assert.equal(resetPasswordSchema.safeParse({ token: 'guess', newPassword: 'long-enough-password' }).success, false)
    assert.equal(resetPasswordSchema.safeParse({ token: 'a'.repeat(43), newPassword: 'short' }).success, false)
  })
  it('includes auth version so old access tokens can be revoked on reset', () => {
    const token = signAccessToken({ userId: 'user', email: 'user@example.com', authVersion: 2 })
    assert.equal(verifyAccessToken(token).authVersion, 2)
    assert.equal(verifyAccessToken(signAccessToken({ userId: 'user', email: 'user@example.com' })).authVersion, 0)
  })
})
