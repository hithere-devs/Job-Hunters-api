import crypto from 'node:crypto'
import nodemailer from 'nodemailer'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { passwordResetTokens, refreshTokens, users } from '../../db/schema.js'
import { env, hasMailer } from '../../config/env.js'
import { ApiError, badRequest } from '../../lib/errors.js'
import { hashToken } from '../../lib/jwt.js'
import { hashPassword } from '../../lib/password.js'
import { logger } from '../../lib/logger.js'

export function recoveryConfigured(): boolean {
  if (!hasMailer || !env.AUTH_PASSWORD_RESET_URL) return false
  const url = new URL(env.AUTH_PASSWORD_RESET_URL)
  return url.protocol === 'https:' || (env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname))
}

export function recoveryLink(baseUrl: string, token: string): string {
  const url = new URL(baseUrl)
  // Fragment avoids leaking the secret in HTTP access logs and Referer headers.
  url.hash = new URLSearchParams({ token }).toString()
  return url.toString()
}

export async function requestPasswordReset(email: string): Promise<void> {
  if (!recoveryConfigured()) throw new ApiError(409, 'recovery_unavailable', 'Password recovery is not configured. If you signed up with Google, use Sign in with Google; otherwise contact support.')
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  // Same response for missing and Google-only accounts; never expose account existence.
  if (!user || user.googleSubject) return
  const token = crypto.randomBytes(32).toString('base64url')
  const now = new Date()
  const [row] = await db.insert(passwordResetTokens).values({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + 30 * 60_000) }).returning({ id: passwordResetTokens.id })
  try {
    const transport = nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465, requireTLS: env.SMTP_PORT !== 465, connectionTimeout: 10_000, socketTimeout: 15_000, ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } } : {}) })
    await transport.sendMail({ from: env.MAIL_FROM, to: user.email, subject: 'Reset your Huntly password', text: `Reset your password using this link within 30 minutes:\n${recoveryLink(env.AUTH_PASSWORD_RESET_URL!, token)}\nIf you did not request this, ignore this message.` })
    transport.close()
  } catch {
    if (row) await db.update(passwordResetTokens).set({ consumedAt: new Date() }).where(eq(passwordResetTokens.id, row.id))
    // Never log token, reset URL, SMTP response, password, or recipient.
    logger.error({ userId: user.id }, 'password recovery email delivery failed')
  }
}

export async function resetPassword(token: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password)
  const now = new Date()
  await db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(passwordResetTokens).where(eq(passwordResetTokens.tokenHash, hashToken(token))).limit(1)
    if (!candidate) throw badRequest('This reset link has expired or has already been used. Request a new one.')
    await tx.select({ id: users.id }).from(users).where(eq(users.id, candidate.userId)).for('update')
    const [request] = await tx.update(passwordResetTokens).set({ consumedAt: now }).where(and(eq(passwordResetTokens.tokenHash, hashToken(token)), isNull(passwordResetTokens.consumedAt), gt(passwordResetTokens.expiresAt, now))).returning()
    if (!request) throw badRequest('This reset link has expired or has already been used. Request a new one.')
    await tx.update(users).set({ passwordHash, authVersion: sql`${users.authVersion} + 1`, updatedAt: now }).where(eq(users.id, request.userId))
    await tx.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.userId, request.userId), isNull(refreshTokens.revokedAt)))
    await tx.update(passwordResetTokens).set({ consumedAt: now }).where(and(eq(passwordResetTokens.userId, request.userId), isNull(passwordResetTokens.consumedAt)))
  })
}
