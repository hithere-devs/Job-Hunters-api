/** Read-only integration checks. Does not approve jobs or write application data. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { desc } from 'drizzle-orm'
import { db, closeDatabase } from '../src/db/client.js'
import { huntRuns } from '../src/db/schema.js'
import { jobsQuerySchema, listDashboardJobs } from '../src/modules/dashboard/scraped-jobs.js'
try {
  const [run] = await db.select().from(huntRuns).orderBy(desc(huntRuns.jobsScraped)).limit(1)
  assert(run, 'A hunt is required for the read-only integration check')
  const query = (options: object) => listDashboardJobs(run.userId, jobsQuerySchema.parse({scope:'all', ...options}))
  const stranger = randomUUID()
  const empty = await listDashboardJobs(stranger, jobsQuerySchema.parse({scope:'all'}))
  assert.equal(empty.pagination.total,0)
  await assert.rejects(listDashboardJobs(stranger, jobsQuerySchema.parse({runId:run.id})), /Hunt run not found/)
  console.log('PASS ownership: unknown user sees no jobs; another user’s hunt is rejected')
  const first = await query({page:1,pageSize:100,sort:'score-asc'})
  const second = await query({page:2,pageSize:100,sort:'score-asc'})
  if(first.pagination.totalPages>1) {
    assert.equal(new Set([...first.items,...second.items].map(j=>j.jobId)).size, first.items.length+second.items.length)
    assert((first.items.at(-1)?.score ?? 0) <= (second.items[0]?.score ?? 100))
  }
  console.log('PASS all-hunts dedupe and globally ordered pagination')
  const eligible = await query({status:'eligible'})
  assert.equal(eligible.pagination.total,first.counts.eligible)
  assert(eligible.items.every(j=>j.eligibility==='eligible'))
  console.log('PASS Eligible filter count matches returned results')
  const top = await query({status:'eligible',selectableOnly:'true',sort:'score-desc'})
  assert(top.items.every(j=>j.selectable && !j.blockedReason))
  assert.equal(top.items.length,Math.min(100,top.pagination.total))
  assert(top.items.every((j,i)=>i===0 || (top.items[i-1]!.score ?? -1)>=(j.score ?? -1)))
  console.log('PASS top-100 query includes only available jobs, in the selected order')
  const filtered = await query({minScore:80})
  assert.equal(filtered.counts.all, filtered.pagination.total)
  console.log('PASS filter counts track the current query')
} finally { await closeDatabase() }
