import { and, count, eq, gte, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { applications, attemptFlags, portalAccounts, userBrowserSessions, userSchedules, huntSpecs } from '../../db/schema.js'
import { applicationQueueHealth } from '../../hunt/application-queue.js'
import { dailyBudget, effectiveConcurrency } from '../../hunt/application-policy.js'
import { readApplyFields } from '../../persona/apply-fields.js'
import { providerCatalogue } from '../../browser/provider-catalogue.js'
import { browserProvider, env } from '../../config/env.js'

export async function applicationPreflight(userId: string, portals: string[] = []) {
  const [health, fields, [session], [schedule], accounts, [used], [flag], [spec]] = await Promise.all([
    applicationQueueHealth(), readApplyFields(userId),
    db.select().from(userBrowserSessions).where(eq(userBrowserSessions.userId, userId)).limit(1),
    db.select().from(userSchedules).where(eq(userSchedules.userId, userId)).limit(1),
    db.select().from(portalAccounts).where(eq(portalAccounts.userId, userId)),
    db.select({ value: count() }).from(applications).where(and(eq(applications.userId, userId), gte(applications.queuedAt, dailyBudget(0).start), sql`not (${applications.status} = 'closed' and ${applications.notes} is not distinct from 'Cancelled before application started.')`)),
    db.select({ id: attemptFlags.id }).from(attemptFlags).where(and(eq(attemptFlags.userId, userId), eq(attemptFlags.status, 'open'))).limit(1),
    db.select({target:huntSpecs.dailyTarget}).from(huntSpecs).where(eq(huntSpecs.userId,userId)).limit(1),
  ])
  const budget = dailyBudget(used?.value ?? 0,spec?.target??100)
  const gaps: Array<{code: string; message: string; href: string}> = []
  const warnings: typeof gaps = []
  if (!health.redisAvailable || !health.workerConnected || health.paused) gaps.push({code: 'runner_unavailable', message: health.paused ? 'The application runner is paused. Your existing jobs are saved.' : 'The application runner is offline. Your existing jobs are saved.', href: '/app/jobs'})
  if (!env.PORTAL_AUTOMATION_ENABLED) gaps.push({code: 'automation_disabled', message: 'Application automation is disabled by this deployment.', href: '/app/jobs'})
  if (!fields.hasBaseResume) gaps.push({code: 'resume_missing', message: 'Upload a resume before applying.', href: '/app/profile'})
  else if (fields.resumeStatus !== 'parsed') gaps.push({code:'resume_not_ready',message:fields.resumeStatus === 'failed'?'Resume parsing failed. Replace or retry the resume upload.':'Your resume is still being processed. Wait before applying.',href:'/app/profile'})
  for (const field of fields.missingRequired) gaps.push({code: `profile_${field}`, message: `Add ${fields.fields.find(f => f.id === field)?.label ?? field} to My Kit.`, href: '/app/profile'})
  if (browserProvider === 'vm' && (!session || ['absent','failed'].includes(session.status))) gaps.push({code: 'browser_missing', message: 'Set up your browser before applying.', href: '/browser-session'})
  if (session?.status === 'connecting') gaps.push({code: 'browser_busy', message: 'Save and exit browser setup before applying.', href: '/browser-session'})
  if (flag) gaps.push({code: 'review_paused', message: 'Your future applications are paused while a flagged attempt is reviewed.', href: '/app/jobs'})
  if (!budget.remaining) gaps.push({code: 'daily_limit', message: `Your daily application allowance resets at ${budget.resetsAt}.`, href: '/app/jobs'})
  const catalogue = providerCatalogue()
  const providers = [...new Set(portals)].map(id => {
    const capability = catalogue.find(provider => provider.id === id)
    const requiresAccount = capability?.requiresAccount ?? false
    const account = accounts.find(a => a.portalId === id)
    const ready = !requiresAccount || (capability?.available !== false && account?.status === 'ready' && Boolean(account.lastVerifiedAt) && Date.now() - account.lastVerifiedAt!.getTime() < 24 * 60 * 60_000)
    const message = ready ? (requiresAccount ? 'Account verified' : 'No account required for this application flow') : 'Connect and verify this provider account before applying.'
    if (!ready) gaps.push({code: `provider_${id}`, message: `${id}: ${message}`, href: '/browser-session'})
    return { id, ready, message }
  })
  if (env.APPLY_DRY_RUN) warnings.push({code: 'dry_run', message: 'Preparation mode: forms can be filled, but final submission is disabled.', href: '/app/jobs'})
  if (fields.missingOptional.length) warnings.push({code: 'profile_optional', message: 'Some commonly requested profile fields are missing. Individual applications may need review.', href: '/app/profile'})
  return { ...health, canApply: gaps.length === 0, gaps, warnings, providers,
    configuredConcurrency: schedule?.applyConcurrency ?? 1,
    effectiveConcurrency: effectiveConcurrency(schedule?.applyConcurrency ?? 1, Boolean(session)),
    dailyLimit: budget.limit, dailyUsed: budget.used, dailyRemaining: budget.remaining, resetsAt: budget.resetsAt,
    applicationEmail: fields.fields.find(f => f.id === 'email')?.value ?? null,
    browserSession: session ? {status: session.status, vmId: session.vmId, tenantIndex: session.tenantIndex} : null,
  }
}
