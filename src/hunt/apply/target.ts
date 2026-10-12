import type { Page } from 'playwright-core'
import { logger } from '../../lib/logger.js'
import { browserProvider, env } from '../../config/env.js'
import { skillForUrl } from '../../skills/registry.js'
import { pageLooksLikeNoForm } from './fill.js'
import { greenhouseEmbedApplicationUrl, greenhouseFromListingUrl, greenhouseJobBoardUrl, greenhouseJobPathUrl, openEmbeddedApplication, resolveApplyUrl } from './recipes.js'
import { normaliseHttpUrl } from './urls.js'
import { declineCookieBanner } from './cookie-banner.js'

export interface ApplicationTarget {
  applyUrl: string
  greenhouseFallback: string | null
  host: string
  /** Every URL that might identify this posting, for schema lookup. */
  urls: string[]
}

/** Which URL to open, preferring the ATS's own form over a listing. */
export function resolveApplicationTarget(
  job: { applyUrl: string | null; canonicalUrl: string },
  source: { sourceId?: string | null; applyUrl?: string | null } | undefined,
): ApplicationTarget | null {
  const greenhouseFallback = greenhouseEmbedApplicationUrl(source?.sourceId)
    || greenhouseJobBoardUrl(source?.sourceId)
    || greenhouseFromListingUrl(job.applyUrl, source?.sourceId)
    || greenhouseFromListingUrl(source?.applyUrl, source?.sourceId)
    || greenhouseFromListingUrl(job.canonicalUrl, source?.sourceId)
    || null
  let applyUrl = greenhouseFallback
    || normaliseHttpUrl(resolveApplyUrl({ jobApplyUrl: job.applyUrl, sourceApplyUrl: source?.applyUrl, canonicalUrl: job.canonicalUrl, sourceId: source?.sourceId }))
    || normaliseHttpUrl(job.applyUrl ?? source?.applyUrl ?? job.canonicalUrl)
  if (!applyUrl) return null
  if (greenhouseFallback && !greenhouseJobPathUrl(applyUrl)) applyUrl = greenhouseFallback
  const urls = [applyUrl, greenhouseFallback, job.applyUrl, source?.applyUrl, job.canonicalUrl]
    .map((url) => (url ? normaliseHttpUrl(url) : ''))
    .filter((url): url is string => Boolean(url))
  return { applyUrl, greenhouseFallback, host: new URL(applyUrl).hostname.toLowerCase(), urls: [...new Set(urls)] }
}

const SIGNED_IN_HOSTS = /(?:^|\.)(?:wellfound\.com|angel\.co|instahyre\.com|linkedin\.com|workatastartup\.com|indeed\.com|naukri\.com|hirist\.tech|cutshort\.io)$/i

/**
 * Whether this application needs the user's signed-in browser profile. Only
 * account-based portals do; ATS forms are anonymous and get a throwaway context.
 */
export function requiresSignedInProfile(urls: string[]): boolean {
  if (browserProvider === 'vm' && env.APPLY_ANON_BROWSER === 'profile') return true
  return urls.some((url) => {
    try {
      const host = new URL(url).hostname.toLowerCase()
      return SIGNED_IN_HOSTS.test(host) || skillForUrl(url)?.manifest.authMode === 'profile'
    } catch {
      return false
    }
  })
}

/** Navigate to the form, falling back to the Greenhouse board URL, and lift embedded forms to the top level. */
export async function openApplicationPage(page: Page, target: ApplicationTarget, attemptId: string): Promise<string> {
  try {
    await page.goto(target.applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  } catch (error) {
    logger.warn({ err: error, attemptId, host: target.host }, 'initial application navigation failed')
    if (!target.greenhouseFallback || target.greenhouseFallback === target.applyUrl) throw error
    await page.goto(target.greenhouseFallback, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  }
  if (target.greenhouseFallback && await pageLooksLikeNoForm(page) && !/job-boards\.greenhouse\.io|boards\.greenhouse\.io/i.test(page.url())) {
    await page.goto(target.greenhouseFallback, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((error) => {
      logger.warn({ err: error, attemptId }, 'listing fallback navigation failed')
    })
  }
  const embedded = await openEmbeddedApplication(page).catch((error) => {
    logger.warn({ err: error, attemptId }, 'embedded application navigation failed')
    return null
  })
  await declineCookieBanner(page, 2_500).catch(() => false)
  return embedded ?? page.url()
}
