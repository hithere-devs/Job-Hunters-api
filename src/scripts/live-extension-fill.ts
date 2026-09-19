import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq, or } from 'drizzle-orm'
import { openSession } from '../browser/session.js'
import { env } from '../config/env.js'
import { db, closeDatabase } from '../db/client.js'
import { jobSources, jobs, userBrowserSessions, users } from '../db/schema.js'
import { applyWithExtension } from '../hunt/apply/extension-driver.js'
import { emptyRequiredFields, ensureHuntlyApply, inventoryFields } from '../hunt/apply/extension-page.js'
import { postingIsClosed, submitForm } from '../hunt/apply/fill.js'
import { launchLaptopChromeWithExtension } from '../hunt/apply/laptop-chrome.js'
import {
  greenhouseEmbedApplicationUrl,
  greenhouseFromListingUrl,
  greenhouseJobBoardUrl,
  openEmbeddedApplication,
  resolveApplyUrl,
} from '../hunt/apply/recipes.js'
import { countryCodeFor } from '../hunt/apply/work-authorisation.js'
import { loadPortalProfile } from '../hunt/portal-profile.js'
import { downloadObject } from '../lib/storage.js'
import type { Page } from 'playwright-core'

/**
 * Fill a live ATS application with Huntly Apply. Never submits.
 *
 * Laptop:  BROWSER_PROVIDER=local APPLY_DRIVER=extension APPLY_DRY_RUN=true npm run apply-extension:live
 * VM:      BROWSER_PROVIDER=vm APPLY_DRIVER=extension APPLY_DRY_RUN=true npm run apply-extension:live
 */
const BLOCKED = /atlan|jobs\.ashbyhq\.com\/render|mercor\/296c4031-5e98-4772-95f5-a9eb5bd7746d|mercor\/3750ee8a-64d1-46ac-b4f9-6a823f949034/i
const email = process.argv[2] ?? 'mywritingfrenzy@gmail.com'
const url = process.argv[3] ?? 'https://job-boards.greenhouse.io/embed/job_app?for=mongodb&token=8089859'

function sourceIdFromUrl(target: string): string | null {
  try {
    const parsed = new URL(target)
    const board = parsed.searchParams.get('for')
    const token = parsed.searchParams.get('token') ?? parsed.searchParams.get('gh_jid')
    if (board && token && /^\d+$/.test(token)) return `${board}:${token}`
    const pathMatch = /^\/([a-z0-9-]+)\/jobs\/(\d+)/i.exec(parsed.pathname)
    if (parsed.hostname.toLowerCase().includes('greenhouse.io') && pathMatch?.[1] && pathMatch[2]) {
      return `${pathMatch[1]}:${pathMatch[2]}`
    }
  } catch {
    return null
  }
  return null
}

if (BLOCKED.test(url)) {
  console.error(`blocked URL: ${url}`)
  process.exit(1)
}

const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
if (!user) {
  console.error(`no user ${email}`)
  process.exit(1)
}

const profile = await loadPortalProfile(user.id)
const scratch = await mkdtemp(path.join(os.tmpdir(), 'huntly-live-ext-'))
const resumePath = path.join(scratch, profile.baseResume.fileName)
await writeFile(resumePath, await downloadObject(profile.baseResume.storagePath))

const vm = env.BROWSER_PROVIDER === 'vm'
let page: Page
let proofDir: string
let extensionId = 'unknown'
let close = async () => {}

if (vm) {
  const [slot] = await db.select().from(userBrowserSessions).where(eq(userBrowserSessions.userId, user.id)).limit(1)
  if (!slot) {
    console.error(`no VM browser slot for ${email}`)
    process.exit(1)
  }
  const session = await openSession({
    userId: user.id,
    label: 'live-ext-fill',
    profileId: `vm:${slot.vmId}:${slot.tenantIndex}`,
  })
  page = await session.context.newPage()
  proofDir = path.join(os.tmpdir(), 'huntly-live-ext-proof')
  await mkdir(proofDir, { recursive: true })
  close = async () => { await session.close() }
} else {
  const launched = await launchLaptopChromeWithExtension()
  page = await launched.context.newPage()
  proofDir = path.join(launched.profileDir, 'proof')
  await mkdir(proofDir, { recursive: true })
  extensionId = launched.extensionId
  close = async () => { await launched.disconnect() }
}

try {
  console.log(`profile: ${profile.fullName} · ${profile.email}`)
  console.log(`chrome:  ${vm ? 'VM Huntly Apply' : `Huntly Apply ${extensionId}`}`)
  console.log(`url:     ${url}`)

  const guessedSourceId = sourceIdFromUrl(url)
  const [source] = guessedSourceId
    ? await db.select().from(jobSources).where(eq(jobSources.sourceId, guessedSourceId)).limit(1)
    : []
  const [job] = source
    ? await db.select().from(jobs).where(eq(jobs.id, source.jobId)).limit(1)
    : await db.select().from(jobs).where(or(eq(jobs.applyUrl, url), eq(jobs.canonicalUrl, url))).limit(1)
  const applyUrl = greenhouseEmbedApplicationUrl(source?.sourceId ?? guessedSourceId)
    || greenhouseJobBoardUrl(source?.sourceId ?? guessedSourceId)
    || greenhouseFromListingUrl(url, source?.sourceId ?? guessedSourceId)
    || resolveApplyUrl({
      jobApplyUrl: url,
      sourceApplyUrl: source?.applyUrl,
      canonicalUrl: job?.canonicalUrl,
      sourceId: source?.sourceId ?? guessedSourceId,
    })
    || url
  console.log(`apply:   ${applyUrl}`)
  const dryRun = process.env.LIVE_SUBMIT === '1' ? false : true
  console.log(`submit:  ${dryRun ? 'disabled (dry_run)' : 'LIVE'}\n`)

  await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await openEmbeddedApplication(page).catch(() => undefined)
  const closed = await postingIsClosed(page)
  if (!closed) {
  await page.waitForSelector(
    '.ashby-application-form-field-entry, [data-field-entry-id], #application_form, form#application-form, form input:not([type="hidden"])',
    { timeout: 25_000 },
  ).catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  await ensureHuntlyApply(page, { injectIfMissing: false })
  const before = await inventoryFields(page)
  const candidateCountry = countryCodeFor(profile.address.country)
  const authorisedAtHome = /^(?:yes|true|y)$/i.test((profile.workAuthorization ?? '').trim())
    ? true
    : /^(?:no|false|n)$/i.test((profile.workAuthorization ?? '').trim())
      ? false
      : undefined
  const jobCountries = (job?.locations as Array<{ countryCode?: string | null; raw?: string }> | undefined ?? [])
    .flatMap((place) => [place.countryCode, place.raw])
    .filter((value): value is string => Boolean(value))
  const result = await applyWithExtension({
    page,
    url: page.url(),
    userId: user.id,
    attemptId: `live-ext-${Date.now()}`,
    profile,
    resumePath,
    authorisation: {
      candidateCountry,
      jobCountries,
      remote: job?.remoteMode === 'remote',
      ...(candidateCountry && authorisedAtHome !== undefined
        ? { explicitAnswers: { [candidateCountry]: { authorised: authorisedAtHome } } }
        : {}),
    },
    job: {
      applicationId: 'live-ext',
      role: job?.title ?? '',
      company: job?.company ?? '',
      location: jobCountries.join('; ') || null,
    },
  })
  const leftover = await emptyRequiredFields(page)
  const submit = result.canSubmit || leftover.length === 0
    ? await submitForm({ page, url: page.url(), dryRun, skipWidgetReady: true })
    : { submitted: false, heldBack: 'invalid_fields' as const }
  const shot = path.join(proofDir, vm ? 'vm-live-filled.png' : 'live-filled.png')
  await page.screenshot({ path: shot, fullPage: true })
  const report = {
    provider: env.BROWSER_PROVIDER,
    applyUrl,
    url: page.url(),
    extensionId,
    recipe: result.recipe,
    inventory: before.map((field) => ({ fid: field.fid, label: field.label, type: field.type, required: field.required })),
    filled: result.fields.filter((row) => row.filled).map((row) => ({ label: row.label, via: row.via })),
    skipped: result.fields.filter((row) => !row.filled).map((row) => ({ label: row.label, via: row.via })),
    unresolved: result.unresolved.map((row) => ({ label: row.label, why: row.why })),
    leftover: leftover.map((field) => field.label),
    submitted: submit.submitted,
    heldBack: submit.heldBack,
    screenshot: shot,
  }
  console.log(JSON.stringify(report, null, 2))
  if (submit.submitted) process.exitCode = 2
  else if (result.unresolved.length || leftover.length) process.exitCode = 1
  } else {
    const shot = path.join(proofDir, vm ? 'vm-live-filled.png' : 'live-filled.png')
    await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined)
    console.log(JSON.stringify({ applyUrl, url: page.url(), closed: true, screenshot: shot }, null, 2))
    process.exitCode = 1
  }
} catch (error) {
  await page.screenshot({ path: path.join(proofDir, vm ? 'vm-live-error.png' : 'live-error.png'), fullPage: true }).catch(() => undefined)
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exitCode = 1
} finally {
  await Promise.race([close(), new Promise((resolve) => setTimeout(resolve, 8_000))]).catch(() => undefined)
  await closeDatabase().catch(() => undefined)
  console.log(vm ? 'VM Chrome stopped.' : 'Chrome left open on the live form.')
  process.exit(process.exitCode ?? 0)
}
