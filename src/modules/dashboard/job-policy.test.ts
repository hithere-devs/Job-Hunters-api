import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { eligibilityOf, selectionBlockedReason, isAggregatorApplicationUrl, ownedJobSelection } from './job-policy.js'
import { jobsQuerySchema } from './scraped-jobs.js'

describe('scraped job eligibility and selection', () => {
  const input = {runStatus:'applying', status:'rejected', applicationStatus:null, activeCandidate:false, reasons:[]}
  it('keeps previously unselected jobs selectable', () => assert.equal(selectionBlockedReason(input), null))
  it('restores eligibility for legacy unselected candidates', () => assert.equal(eligibilityOf('rejected', null, true), 'eligible'))
  it('preserves a weak match after an application is queued', () => assert.equal(eligibilityOf('queued', 'below_threshold', true), 'below_threshold'))
  it('does not invent eligibility for an unscored job', () => assert.equal(eligibilityOf('needs_review', null, false), 'scraped'))
  it('does not confuse score decisions with application state', () => assert.equal(eligibilityOf('insufficient_skills', null, false), 'insufficient_skills'))
  it('blocks already queued jobs and explains why', () => assert.match(selectionBlockedReason({...input,applicationStatus:'queued'})!, /Applications/))
  it('blocks processed jobs from another hunt', () => assert.match(selectionBlockedReason({...input,activeCandidate:true})!, /processed/))
  it('blocks closed jobs', () => assert.match(selectionBlockedReason({...input,status:'closed'})!, /closed/))
  it('blocks runs still discovering jobs', () => assert.match(selectionBlockedReason({...input,runStatus:'running'})!, /discovery/))
  it('does not queue aggregator-only candidates', () => assert.match(selectionBlockedReason({...input,reasons:['no_applyable_url']})!, /direct application/))
  it('accepts all-hunts, pagination, eligibility and global sorting together', () => {
    const q=jobsQuerySchema.parse({scope:'all',page:2,pageSize:100,status:'eligible',sort:'score-asc',selectableOnly:'true'})
    assert.equal(q.page,2); assert.equal(q.sort,'score-asc'); assert.equal(q.selectableOnly,'true')
  })
  it('rejects lifecycle filters and invalid sorts instead of silently ignoring them', () => {
    assert.equal(jobsQuerySchema.safeParse({status:'queued'}).success,false)
    assert.equal(jobsQuerySchema.safeParse({sort:'anything'}).success,false)
  })
})


describe('manual job ownership and URL protection', () => {
  it('rejects an entire mixed-owner batch', () => assert.equal(ownedJobSelection('a', [{runId:'r',jobId:'1'},{runId:'r2',jobId:'2'}], [{userId:'a',runId:'r',jobId:'1'},{userId:'b',runId:'r2',jobId:'2'}]), null))
  it('rejects a job paired with a different hunt', () => assert.equal(ownedJobSelection('a', [{runId:'wrong',jobId:'1'}], [{userId:'a',runId:'r',jobId:'1'}]), null))
  it('returns only selected jobs, leaving the rest untouched', () => {
    const rows=[{userId:'a',runId:'r',jobId:'1'},{userId:'a',runId:'r',jobId:'2'}]
    assert.deepEqual(ownedJobSelection('a', [{runId:'r',jobId:'1'}], rows), [rows[0]])
    assert.equal(rows.length, 2)
  })
  it('blocks legacy aggregator links but allows direct provider pages', () => {
    for(const url of ['https://www.adzuna.co.uk/jobs/1','https://jooble.org/desc/1','https://weworkremotely.com/jobs/1']) assert.equal(isAggregatorApplicationUrl(url),true)
    for(const url of ['https://jobs.ashbyhq.com/company/1','https://wellfound.com/jobs/1','https://www.instahyre.com/job/1','https://example.com/adzuna.co.uk']) assert.equal(isAggregatorApplicationUrl(url),false)
  })
})
