/**
 * Application evaluation, without applying anywhere.
 *
 *   npm run apply:eval -- fixtures
 *     Runs the planned driver end to end in Chrome against local replicas of
 *     Greenhouse and Ashby forms. Fixture only.
 *
 *   npm run apply:eval -- coverage --user you@example.com [--limit 40] [--plan]
 *     For the user's recent applications: fetch each posting's published form
 *     (public ATS APIs, read-only), decide answers deterministically, and with
 *     --plan also run the answer planner (a model call per form). Prints how
 *     many forms would start with every required answer known, and groups the
 *     questions that still need the user, so the Kit can be completed once.
 *     Opens no browser and contacts no employer beyond reading the public form.
 */
import { spawnSync } from 'node:child_process'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { applications, huntCandidates, jobSources, jobs, users } from '../db/schema.js'
import { loadPortalProfile } from '../hunt/portal-profile.js'
import { deterministicAnswer } from '../hunt/apply/planned/answers.js'
import { dossierFromProfile, jobContext, loadSavedAnswers } from '../hunt/apply/planned/dossier.js'
import { planAnswers, unansweredRequired } from '../hunt/apply/planned/planner.js'
import { loadPublishedSchema } from '../hunt/apply/planned/schema/index.js'
import { resolveApplicationTarget } from '../hunt/apply/target.js'
import { countryCodeFor } from '../hunt/apply/work-authorisation.js'

const args = process.argv.slice(2)
const mode = args[0] ?? 'fixtures'
const flag = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined }

if (mode === 'fixtures') {
  const result = spawnSync('npx', ['tsx', '--test', '--test-timeout=120000', 'src/hunt/apply/planned/driver.test.ts', 'src/hunt/apply/planned/answers.test.ts', 'src/hunt/apply/planned/schema/schema.test.ts', 'src/hunt/apply/confirmation.test.ts'], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

if (mode !== 'coverage') {
  console.error('Usage: apply:eval -- fixtures | coverage --user <email> [--limit N] [--plan]')
  process.exit(2)
}

const email = flag('user')
if (!email) throw new Error('--user <email> is required')
const limit = Number(flag('limit') ?? 40)
const plan = args.includes('--plan')
const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
if (!user) throw new Error(`No user ${email}`)
const profile = await loadPortalProfile(user.id)
const dossier = dossierFromProfile(profile, await loadSavedAnswers(user.id))
const rows = await db.select({ application: applications, job: jobs, candidate: huntCandidates })
  .from(applications).innerJoin(jobs, eq(jobs.id, applications.jobId))
  .innerJoin(huntCandidates, and(eq(huntCandidates.jobId, jobs.id), eq(huntCandidates.userId, user.id)))
  .where(and(eq(applications.userId, user.id), inArray(applications.status, ['needs_review', 'queued', 'failed'])))
  .orderBy(desc(applications.updatedAt)).limit(limit)

let forms = 0
let ready = 0
let closed = 0
let noSchema = 0
let planned = 0
let planErrors = 0
let planMs = 0
let shown = 0
const missing = new Map<string, { count: number; companies: Set<string> }>()
for (const row of rows) {
  const [source] = await db.select().from(jobSources).where(and(eq(jobSources.jobId, row.job.id), eq(jobSources.portalId, row.candidate.sourcePortal))).limit(1)
  const target = resolveApplicationTarget(row.job, source)
  if (!target) continue
  const schema = await loadPublishedSchema(target.urls)
  if (!schema) { noSchema += 1; console.log(`- ${row.job.company}: no published schema (${target.host}); the driver will read the page`); continue }
  if (schema.closed) { closed += 1; console.log(`- ${row.job.company}: posting closed`); continue }
  forms += 1
  const locations = row.job.locations as Array<{ raw?: string; countryCode?: string | null }>
  const job = jobContext({ title: row.job.title, company: row.job.company, location: locations.map((place) => place.raw).filter(Boolean).join('; ') || null, countries: locations.map((place) => place.countryCode ?? '').filter(Boolean), remote: row.job.remoteMode === 'remote', description: row.job.descriptionText })
  if (!job.countries.length) { const code = countryCodeFor(job.location); if (code) job.countries.push(code) }
  let asks: Array<{ label: string }>
  let deterministic = 0
  if (plan) {
    const started = Date.now()
    try {
      const result = await planAnswers({ userId: user.id, schema, dossier, job })
      asks = unansweredRequired(result)
      if (args.includes('--show') && shown < 3) {
        shown += 1
        console.log(`\n  ${row.job.company} — model answers:`)
        for (const answer of result.answers.filter((row) => row.basis === 'model' || row.basis === 'resume' || row.basis === 'derived')) {
          console.log(`    • ${answer.label.slice(0, 90)}\n      → ${answer.action === 'fill' ? answer.values.join(' | ').slice(0, 400) : `(${answer.action}: ${answer.reason ?? ''})`}`)
        }
      }
      deterministic = result.answers.filter((answer) => answer.basis !== 'model' && answer.basis !== 'resume').length
      planned += 1
      planMs += Date.now() - started
    } catch (error) {
      planErrors += 1
      console.log(`- ${row.job.company}: planner failed: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
  } else {
    const decided = schema.fields.map((field) => ({ field, answer: deterministicAnswer(field, dossier, job) }))
    deterministic = decided.filter((row) => row.answer).length
    asks = decided.filter((row) => row.field.required && (!row.answer || row.answer.action === 'ask')).map((row) => ({ label: row.field.label }))
  }
  if (!asks.length) ready += 1
  for (const ask of asks) {
    const key = ask.label.replace(/\s+/g, ' ').trim().slice(0, 140)
    const entry = missing.get(key) ?? { count: 0, companies: new Set<string>() }
    entry.count += 1
    entry.companies.add(row.job.company)
    missing.set(key, entry)
  }
  console.log(`- ${row.job.company} (${schema.source}): ${schema.fields.length} fields, ${deterministic} answered without a model, ${asks.length} required ${plan ? 'still need you' : 'left for the planner'}`)
}

console.log(`\n${forms} forms with a published schema, ${closed} closed, ${noSchema} without a schema.`)
if (plan) console.log(`Planner: ${planned} planned (avg ${planned ? Math.round(planMs / planned / 100) / 10 : 0}s), ${planErrors} failed.`)
console.log(`${ready}/${forms} would start with every required answer known${plan ? '' : ' from My Kit alone (run with --plan to include the model)'}.`)
if (missing.size) {
  console.log(`\nRequired questions ${plan ? 'that still need you' : 'not answerable from My Kit alone'}, most common first:`)
  for (const [label, entry] of [...missing.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 30)) {
    console.log(`  ${String(entry.count).padStart(3)}×  ${label}  [${[...entry.companies].slice(0, 3).join(', ')}]`)
  }
}
await closeDatabase()
