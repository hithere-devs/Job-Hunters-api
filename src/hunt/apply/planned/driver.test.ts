import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'
import { hasSubmissionConfirmation, submitForm } from '../fill.js'
import { applyPilotSource } from '../pilot-page.js'
import { withSubmissionGuard } from '../submission-guard.js'
import { closeAttemptEvents } from '../events.js'
import { closeRedis } from '../../../lib/redis.js'
import { executePlannedApplication, type DriverLookups, type PreparedApplication } from './driver.js'
import { berlinJob, fixtureDossier, usJob } from './fixtures/dossier.js'
import { ashbyFixtureSchema, greenhouseFixtureSchema, serveFormFixtures } from './fixtures/forms.js'
import { planAnswers, type PlannerTransport } from './planner.js'

/**
 * End to end against local replicas of the Greenhouse and Ashby forms, in a
 * real Chrome. Fixture only: the "employer" is a local server.
 */

const chromePath = process.env.TEST_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser: Browser | null = await chromium.launch({ headless: true, executablePath: chromePath }).catch(() => null)
const noDb: DriverLookups = { userAnswers: async () => new Map(), savedAnswers: async () => [] }
const FAST = { visibleMs: 3_000, writesMs: 2_000, quietMs: 200, pollMs: 100 }

/** A planner that answers like a careful model would, keyed by question text. */
function stubPlanner(overrides: Record<string, { action: 'fill' | 'skip' | 'ask'; values: string[] }> = {}): PlannerTransport & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    async plan({ requestText }) {
      const fields = JSON.parse(requestText.split('FORM FIELDS TO ANSWER (JSON)\n')[1]!) as Array<{ key: string; label: string; options?: string[] }>
      seen.push(...fields.map((field) => field.label))
      return {
        model: 'stub',
        output: {
          answers: fields.map((field) => {
            const override = Object.entries(overrides).find(([label]) => field.label.includes(label))?.[1]
            if (override) return { key: field.key, ...override, basis: 'model' as const, confidence: 0.9, reason: 'fixture' }
            if (/sponsorship/i.test(field.label)) return { key: field.key, action: 'fill' as const, values: ['Yes, but not one of the visas listed here'], basis: 'derived' as const, confidence: 0.9, reason: 'Needs sponsorship outside India; no listed visa applies.' }
            if (/relocation\?/i.test(field.label)) return { key: field.key, action: 'fill' as const, values: ['Yes'], basis: 'kit' as const, confidence: 0.95, reason: 'Kit: willing to relocate.' }
            if (/relocate to/i.test(field.label)) return { key: field.key, action: 'fill' as const, values: ['Berlin'], basis: 'derived' as const, confidence: 0.9, reason: 'The job is in Berlin.' }
            if (/Why Acme/i.test(field.label)) return { key: field.key, action: 'fill' as const, values: ['I have spent four years building payments APIs in Go at Globex, and Acme is solving the same reliability problems at a larger scale.'], basis: 'resume' as const, confidence: 0.85, reason: 'Grounded in résumé.' }
            if (/Which office/i.test(field.label)) return { key: field.key, action: 'fill' as const, values: field.options ?? [], basis: 'derived' as const, confidence: 0.9, reason: 'Willing to relocate; both offices.' }
            return { key: field.key, action: 'ask' as const, values: [], basis: 'model' as const, confidence: 0, reason: 'unknown in fixture' }
          }),
        },
      }
    },
  }
}

describe('planned driver on ATS replicas', { skip: !browser }, () => {
  let fixtures: Awaited<ReturnType<typeof serveFormFixtures>>
  let resumePath = ''
  before(async () => {
    fixtures = await serveFormFixtures()
    const dir = await mkdtemp(path.join(os.tmpdir(), 'huntly-driver-test-'))
    resumePath = path.join(dir, 'Asha_Rao_Resume.pdf')
    await writeFile(resumePath, '%PDF-1.4\n% fixture résumé\n')
  })
  // Live field events open a Redis publisher when REDIS_URL is configured; close
  // it, or this test process never exits.
  after(async () => { await browser?.close(); await fixtures?.close(); await closeAttemptEvents().catch(() => undefined); await closeRedis().catch(() => undefined) })

  async function open(pathname: string): Promise<Page> {
    const context = await browser!.newContext()
    await context.addInitScript({ content: applyPilotSource() })
    const page = await context.newPage()
    await page.goto(`${fixtures.origin}${pathname}`, { waitUntil: 'domcontentloaded' })
    return page
  }

  async function prepared(schema: ReturnType<typeof greenhouseFixtureSchema>, transport: PlannerTransport, job = berlinJob): Promise<PreparedApplication> {
    const dossier = fixtureDossier()
    const plan = await planAnswers({ userId: 'u', schema, dossier, job, transport })
    return { schema, plan, dossier, job, closed: false, missing: plan.answers.filter((row) => row.required && row.action === 'ask') }
  }

  it('fills a Greenhouse-style form completely, reveals the conditional question, and confirms only after the real submit', async () => {
    const page = await open('/acme/jobs/123')
    const transport = stubPlanner()
    const schema = greenhouseFixtureSchema(page.url())
    const ready = await prepared(schema, transport)
    assert.equal(ready.missing.length, 0)
    // The description says "Thank you for your interest": not a confirmation.
    assert.equal(await hasSubmissionConfirmation(page, page.url()), false)
    const result = await executePlannedApplication({ page, prepared: ready, userId: 'u', applicationId: 'a', attemptId: 't', resumePath, transport, lookups: noDb })
    assert.deepEqual(result.blockers, [])
    assert.equal(result.canSubmit, true)
    assert.equal(result.resumeAttached, true)
    assert.ok(transport.seen.some((label) => /relocate to/i.test(label)), 'the conditional question was planned once it appeared')
    const outcomes: string[] = []
    const submitted = await withSubmissionGuard(() => submitForm({ page, url: page.url(), dryRun: false, skipWidgetReady: true, settle: FAST }), async () => {}, async (outcome) => { outcomes.push(outcome) })
    assert.equal(submitted.submitted, true, JSON.stringify(submitted))
    assert.deepEqual(outcomes, ['confirmed'])
    const body = fixtures.submissions.at(-1)!.body as Record<string, unknown>
    assert.equal(body.first_name, 'Asha')
    assert.equal(body.email, 'asha@example.com')
    assert.equal(body.question_111, 'Yes, but not one of the visas listed here')
    assert.equal(body.question_222, 'India')
    assert.equal(body.question_333, 'Yes')
    assert.equal(body.relocation_city, 'Berlin')
    assert.equal(body.gender, 'Decline To Self Identify')
    assert.equal(body.question_555, true)
    assert.equal(body.resume, 'Asha_Rao_Resume.pdf')
    await page.context().close()
  })

  it('never clicks submit while a required answer is missing', async () => {
    const before = fixtures.submissions.length
    const page = await open('/acme/jobs/124')
    const transport = stubPlanner({ 'Why Acme': { action: 'ask', values: [] } })
    const ready = await prepared(greenhouseFixtureSchema(page.url()), transport)
    assert.deepEqual(ready.missing.map((row) => row.label), ['Why Acme?'])
    const result = await executePlannedApplication({ page, prepared: ready, userId: 'u', applicationId: 'a', attemptId: 't', resumePath, transport, lookups: noDb })
    assert.equal(result.canSubmit, false)
    assert.ok(result.blockers.some((blocker) => blocker.reason === 'needs_answer' && blocker.label === 'Why Acme?'))
    assert.equal(fixtures.submissions.length, before)
    await page.context().close()
  })

  it('fills an Ashby-style form: yes/no buttons, a multi-select office question, and the texting consent inside Phone', async () => {
    const page = await open('/ashby/mercor/1/application')
    const transport = stubPlanner()
    const ready = await prepared(ashbyFixtureSchema(page.url()), transport, usJob)
    const result = await executePlannedApplication({ page, prepared: ready, userId: 'u', applicationId: 'a', attemptId: 't', resumePath, transport, lookups: noDb })
    assert.deepEqual(result.blockers, [])
    const submitted = await withSubmissionGuard(() => submitForm({ page, url: page.url(), dryRun: false, skipWidgetReady: true, settle: FAST }), async () => {})
    assert.equal(submitted.submitted, true, JSON.stringify(submitted))
    const body = fixtures.submissions.at(-1)!.body as { offices: string[]; sponsor: string; textConsent: string }
    assert.deepEqual(body.offices.sort(), ['NYC', 'SF'])
    assert.equal(body.sponsor, 'Yes')
    assert.equal(body.textConsent, 'notGiven')
    await page.context().close()
  })
})
