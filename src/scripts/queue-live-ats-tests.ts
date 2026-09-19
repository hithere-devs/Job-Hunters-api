import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { huntCandidates, huntRunJobs, huntRuns, jobSources, jobs, users } from '../db/schema.js'
import { enqueueApprovedCandidates } from '../hunt/application-queue.js'
import { fingerprintOf, normaliseLocations } from '../hunt/discovery/normalise.js'

const args = process.argv.slice(2)
const email = args.find((value) => value.includes('@')) ?? 'mywritingfrenzy@gmail.com'
const skip = new Set(args.filter((value) => !value.includes('@')))
const BLOCKED_COMPANIES = new Set(['mongodb', 'mercor', 'atlan', 'render', 'gitlab', 'elastic', 'meesho', 'sodexo', 'sarvam', 'supabase', 'watershed'])

type LiveJob = {
  portal: string
  sourceId: string
  title: string
  company: string
  url: string
  applyUrl: string
  locationText: string
  postedAt: Date
}

async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${url} ${response.status}`)
  return response.json()
}

async function greenhouse(): Promise<LiveJob | null> {
  for (const token of ['cloudflare', 'vercel', 'postman', 'stripe', 'groww', 'phonepe']) {
    const data = await json(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`) as { jobs?: Array<{ id: number; title: string; absolute_url: string; location?: { name?: string }; updated_at?: string; company_name?: string }> }
    const job = (data.jobs ?? []).find((row) => /engineer|developer|frontend|backend|full.?stack/i.test(row.title))
    if (!job) continue
    const company = job.company_name?.trim() || token
    if (BLOCKED_COMPANIES.has(company.toLowerCase()) || BLOCKED_COMPANIES.has(token)) continue
    const detail = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${job.id}?questions=true`, { signal: AbortSignal.timeout(20_000) })
    if (detail.status === 404) continue
    const applyUrl = job.absolute_url.includes('greenhouse.io')
      ? job.absolute_url
      : `https://boards.greenhouse.io/${token}/jobs/${job.id}`
    return {
      portal: 'greenhouse',
      sourceId: `${token}:${job.id}`,
      title: job.title,
      company,
      url: applyUrl,
      applyUrl,
      locationText: job.location?.name ?? 'Remote',
      postedAt: job.updated_at ? new Date(job.updated_at) : new Date(),
    }
  }
  return null
}

async function lever(): Promise<LiveJob | null> {
  for (const token of ['paytm', 'spotify', 'cred']) {
    const rows = await json(`https://api.lever.co/v0/postings/${token}?mode=json`) as Array<{ id: string; text: string; hostedUrl?: string; applyUrl?: string; categories?: { location?: string }; createdAt?: number }>
    const job = rows.find((row) => /engineer|developer|frontend|backend|full.?stack/i.test(row.text))
    if (!job?.hostedUrl) continue
    return {
      portal: 'lever',
      sourceId: `${token}:${job.id}`,
      title: job.text,
      company: token.charAt(0).toUpperCase() + token.slice(1),
      url: job.hostedUrl,
      applyUrl: job.applyUrl ?? job.hostedUrl,
      locationText: job.categories?.location ?? 'Remote',
      postedAt: job.createdAt ? new Date(job.createdAt) : new Date(),
    }
  }
  return null
}

async function ashby(): Promise<LiveJob | null> {
  for (const token of ['posthog', 'linear', 'vanta', 'neon']) {
    const data = await json(`https://api.ashbyhq.com/posting-api/job-board/${token}`) as { jobs?: Array<{ id?: string; title?: string; jobUrl?: string; applyUrl?: string; location?: string; publishedAt?: string }> }
    const job = (data.jobs ?? []).find((row) => row.title && /engineer|developer|frontend|backend|full.?stack/i.test(row.title) && row.jobUrl)
    if (!job?.jobUrl) continue
    return {
      portal: 'ashby',
      sourceId: `${token}:${job.id ?? job.jobUrl}`,
      title: job.title!,
      company: token.charAt(0).toUpperCase() + token.slice(1),
      url: job.jobUrl,
      applyUrl: job.applyUrl ?? `${job.jobUrl.replace(/\/$/, '')}/application`,
      locationText: job.location ?? 'Remote',
      postedAt: job.publishedAt ? new Date(job.publishedAt) : new Date(),
    }
  }
  return null
}

async function workable(): Promise<LiveJob | null> {
  for (const token of ['weekday-1', 'globaldevgroup']) {
    const data = await json(`https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`) as { jobs?: Array<{ shortcode?: string; title?: string; url?: string; application_url?: string; city?: string; country?: string; published_on?: string }> }
    const job = (data.jobs ?? []).find((row) => row.title && /software engineer|backend|full.?stack|frontend/i.test(row.title) && (row.url || row.application_url) && /india/i.test([row.city, row.country].join(' ')))
      ?? (data.jobs ?? []).find((row) => row.title && /software engineer|backend|full.?stack/i.test(row.title) && (row.url || row.application_url))
    if (!job) continue
    const url = job.application_url ?? job.url!
    return {
      portal: 'workable',
      sourceId: `${token}:${job.shortcode ?? url}`,
      title: job.title!,
      company: token === 'weekday-1' ? 'Weekday' : 'Globaldev Group',
      url,
      applyUrl: url,
      locationText: [job.city, job.country].filter(Boolean).join(', ') || 'Remote',
      postedAt: job.published_on ? new Date(job.published_on) : new Date(),
    }
  }
  return null
}

async function smartrecruiters(): Promise<LiveJob | null> {
  for (const company of ['Continental', 'Visa']) {
    const data = await json(`https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=50`) as { content?: Array<{ id: string; name: string; releasedDate?: string; location?: { city?: string; country?: string } }> }
    const job = (data.content ?? []).find((row) => /(?:full stack|software|developer|engineer)/i.test(row.name))
    if (!job) continue
    const url = `https://jobs.smartrecruiters.com/${company}/${job.id}`
    return {
      portal: 'smartrecruiters',
      sourceId: `${company}:${job.id}`,
      title: job.name,
      company,
      url,
      applyUrl: url,
      locationText: [job.location?.city, job.location?.country].filter(Boolean).join(', ') || 'Remote',
      postedAt: job.releasedDate ? new Date(job.releasedDate) : new Date(),
    }
  }
  return null
}

const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
if (!user) throw new Error(`no user ${email}`)

const picked = (await Promise.all([
  skip.has('greenhouse') ? null : greenhouse().catch((error) => { console.error('greenhouse', error instanceof Error ? error.message : error); return null }),
  skip.has('lever') ? null : lever().catch((error) => { console.error('lever', error instanceof Error ? error.message : error); return null }),
  skip.has('ashby') ? null : ashby().catch((error) => { console.error('ashby', error instanceof Error ? error.message : error); return null }),
  skip.has('workable') ? null : workable().catch((error) => { console.error('workable', error instanceof Error ? error.message : error); return null }),
  skip.has('smartrecruiters') ? null : smartrecruiters().catch((error) => { console.error('smartrecruiters', error instanceof Error ? error.message : error); return null }),
])).filter((row): row is LiveJob => Boolean(row))
if (!picked.length) throw new Error('no live ATS jobs found')

let [run] = await db.select({ id: huntRuns.id }).from(huntRuns).where(eq(huntRuns.userId, user.id)).orderBy(desc(huntRuns.createdAt)).limit(1)
if (!run) {
  const [created] = await db.insert(huntRuns).values({ userId: user.id, status: 'applying', targetApplications: picked.length }).returning({ id: huntRuns.id })
  run = created
}
if (!run) throw new Error('could not create hunt run')

const candidateIds: string[] = []
const queued: Array<{ portal: string; company: string; title: string; applyUrl: string }> = []
for (const job of picked) {
  const locations = normaliseLocations(job.locationText)
  const fingerprint = fingerprintOf(`${job.portal}:${job.sourceId}:${job.title}`, job.company, locations)
  const jobId = randomUUID()
  const [stored] = await db.insert(jobs).values({
    id: jobId,
    fingerprint,
    title: job.title,
    company: job.company,
    locations,
    canonicalUrl: job.url,
    applyUrl: job.applyUrl,
    postedAt: Number.isNaN(job.postedAt.getTime()) ? new Date() : job.postedAt,
    postedAtPrecision: 'day',
    skills: [],
    responsibilities: [],
  }).onConflictDoNothing().returning({ id: jobs.id })
  const resolvedJobId = stored?.id ?? (await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.fingerprint, fingerprint)).limit(1))[0]?.id
  if (!resolvedJobId) continue
  await db.insert(jobSources).values({
    jobId: resolvedJobId,
    portalId: job.portal,
    sourceId: job.sourceId,
    sourceUrl: job.url,
    applyUrl: job.applyUrl,
    raw: job,
  }).onConflictDoNothing()
  await db.insert(huntRunJobs).values({
    runId: run.id,
    userId: user.id,
    jobId: resolvedJobId,
    sourcePortal: job.portal,
    status: 'scraped',
    score: 80,
    scoreBreakdown: { test: true },
    reasons: ['live ATS adapter test'],
  }).onConflictDoNothing()
  const [candidate] = await db.insert(huntCandidates).values({
    runId: run.id,
    userId: user.id,
    jobId: resolvedJobId,
    sourcePortal: job.portal,
    score: 80,
    scoreBreakdown: { test: true },
    reasons: ['live ATS adapter test'],
    status: 'discovered',
  }).onConflictDoNothing().returning({ id: huntCandidates.id })
  const candidateId = candidate?.id ?? (await db.select({ id: huntCandidates.id }).from(huntCandidates).where(eq(huntCandidates.jobId, resolvedJobId)).limit(1))[0]?.id
  if (!candidateId) continue
  candidateIds.push(candidateId)
  queued.push({ portal: job.portal, company: job.company, title: job.title, applyUrl: job.applyUrl })
}

const result = await enqueueApprovedCandidates(user.id, run.id, candidateIds)
console.log(JSON.stringify({ runId: run.id, picked: queued, enqueue: result }, null, 2))
await closeDatabase()
