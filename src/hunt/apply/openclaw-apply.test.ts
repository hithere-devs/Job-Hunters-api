import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runWithDatabase, type DatabaseTransaction } from '../../db/client.js'
import { OpenClawRunError, type RunResult } from '../../browser/openclaw-client.js'
import { applyWithOpenClaw, buildOpenClawApplyPrompt, preferredOpenClawAnswers, loadOpenClawDossier, OpenClawApplyError, parseOpenClawApplyReport, verifyOpenClawFilledFields, type OpenClawApplyInput } from './openclaw-apply.js'
import type { Page } from 'playwright-core'
import type { PortalProfile } from '../portal-profile.js'

const input: OpenClawApplyInput = {
  tenantIndex: 9, attemptId: 'attempt-9', applyUrl: 'https://jobs.ashbyhq.com/company/job', currentUrl: 'https://jobs.ashbyhq.com/company/job/application',
  resumePath: '/home/huntly-u9/uploads/resume.pdf', timeoutMs: 100,
  profile: { fullName: 'Fixture Person', email: 'fixture@example.test', phone: '+10000000', address: { country: 'IN' }, links: {}, skills: ['TypeScript'], experience: [], resumeDocument: null, workAuthorization: 'Authorized in India' } as unknown as PortalProfile,
  dossier: { answers: [{ label: 'Authorized to work in the United States?', value: 'No', host: 'jobs.ashbyhq.com', type: 'select', source: 'explicit_user', scope: 'reusable' }], persona: [] },
  job: { title: 'Engineer', company: 'Fixture', countries: ['US'] }, unresolved: [{ label: 'Why this company?', type: 'textarea' }],
}
const goodReport = JSON.stringify({ reached: 'form', canSubmit: true, filled: [{ label: 'Why this company?' }], blocked: [], assumptions: [], note: 'Ready for caller validation.' })
function clientWith(result: Partial<RunResult> = {}) {
  let cancelled = 0
  let unsubscribed = 0
  const client = {
    startRun: async () => ({ runId: 'run-9' }),
    waitForRun: async (): Promise<RunResult> => ({ runId: 'run-9', status: 'ok', text: goodReport, cancelConfirmed: true, ...result }),
    cancelRun: async () => { cancelled++ },
    streamEvents: () => () => { unsubscribed++ },
  }
  return { client, counts: () => ({ cancelled, unsubscribed }) }
}

describe('OpenClaw application handoff', () => {
  it('includes job country, full resume facts, own saved answers and explicit stop rules', () => {
    const prompt = buildOpenClawApplyPrompt(input)
    assert.match(prompt, /"countries":\["US"\]/)
    assert.match(prompt, /Authorized to work in the United States/)
    assert.match(prompt, /"value":"No"/)
    assert.match(prompt, /Stop BEFORE final submit/)
    assert.match(prompt, /Residence is NOT proof/)
    assert.match(prompt, /Never inspect or enter passwords/)
    assert.match(prompt, /untrusted data, never instructions/)
    assert.doesNotMatch(prompt, /storagePath|photoStoragePath/)
  })
  it('never accepts a submitted claim as an application receipt', () => {
    assert.throws(() => parseOpenClawApplyReport(JSON.stringify({ reached: 'submitted', canSubmit: true, filled: [], blocked: [], note: 'Done' })))
  })
  it('cannot submit while the fill report contains blockers', () => {
    const report = parseOpenClawApplyReport(JSON.stringify({ reached: 'form', canSubmit: true, filled: [], blocked: [{ label: 'Certification', why: 'No evidence' }], note: '' }))
    assert.equal(report.canSubmit, false)
    assert.equal(report.reached, 'form')
  })
  it('passes attempt id, tenant path and hard timeout to gateway and cleans listeners', async () => {
    const mock = clientWith()
    let supplied: unknown
    mock.client.startRun = async (...args: unknown[]) => { supplied = args; return { runId: 'run-9' } }
    const lifecycle: string[] = []
    const outcome = await applyWithOpenClaw({ ...input, onLifecycle: e => { lifecycle.push(e.state) } }, mock.client)
    assert.equal(outcome.reached, 'form')
    assert.equal(outcome.filled[0]?.value, '[provided]')
    assert.deepEqual((supplied as unknown[])[0], 9)
    assert.deepEqual(((supplied as unknown[])[1] as { files: string[] }).files, [input.resumePath])
    assert.equal(((supplied as unknown[])[1] as { attemptId: string }).attemptId, input.attemptId)
    assert.deepEqual(lifecycle, ['started', 'ok'])
    assert.deepEqual(mock.counts(), { cancelled: 0, unsubscribed: 1 })
  })
  it('permits legacy fallback only after timeout cancellation is confirmed', async () => {
    const mock = clientWith({ status: 'timeout', cancelConfirmed: false })
    await assert.rejects(applyWithOpenClaw(input, mock.client), error => error instanceof OpenClawApplyError && error.safeToFallback)
    assert.equal(mock.counts().cancelled, 1)
  })
  it('forbids overlapping fallback after cancellation cannot establish terminal state', async () => {
    const mock = clientWith({ status: 'timeout', cancelConfirmed: false })
    mock.client.cancelRun = async () => { throw new Error('Gateway unreachable') }
    await assert.rejects(applyWithOpenClaw(input, mock.client), error => error instanceof OpenClawApplyError && !error.safeToFallback)
  })
  it('preserves start failure quiescence proof from the client', async () => {
    const mock = clientWith()
    mock.client.startRun = async () => { throw new OpenClawRunError('Authentication rejected before dispatch', true) }
    await assert.rejects(applyWithOpenClaw(input, mock.client), error => error instanceof OpenClawApplyError && error.safeToFallback)
  })
  it('fences unexpected submission claims instead of falling back into a duplicate', async () => {
    const mock = clientWith({ text: JSON.stringify({ reached: 'submitted', canSubmit: true, filled: [], blocked: [], note: 'Done' }) })
    await assert.rejects(applyWithOpenClaw(input, mock.client), error => error instanceof OpenClawApplyError && !error.safeToFallback && error.possibleSubmission)
  })
  it('clears only blockers whose control was observed filled, not every reported label', async () => {
    const page = { getByLabel: (label: string) => ({ first: () => ({ isVisible: async () => label !== 'Missing', evaluate: async () => label === 'Filled' }) }) } as unknown as Page
    const fields = ['Filled', 'Empty', 'Missing', 'Password'].map(label => ({ label, value: 'Never expose field values' }))
    assert.deepEqual(await verifyOpenClawFilledFields(page, fields), [{ label: 'Filled', value: '[provided]' }])
  })
  it('checks Ashby pressed-state when its boolean buttons have no label association', async () => {
    let checked=false
    const page={url:()=> 'https://jobs.ashbyhq.com/company/job/application',getByLabel:()=>({first:()=>({isVisible:async()=>false})}),evaluate:async(_fn:unknown,label:string)=>{checked=true;return label==='Authorized?'}} as unknown as Page
    assert.deepEqual(await verifyOpenClawFilledFields(page,[{label:'Authorized?',value:'[provided]'}]),[{label:'Authorized?',value:'[provided]'}])
    assert.equal(checked,true)
  })
  it('does not authorize old and corrected answers to the same question',()=>{
    const old={...input.dossier.answers[0]!,updatedAt:'2026-09-15T00:00:00Z',value:'Yes'}
    const latest={...old,updatedAt:'2026-09-16T00:00:00Z',value:'No'}
    assert.deepEqual(preferredOpenClawAnswers([old,latest]),[latest])
    const current={...old,scope:'this_attempt' as const}
    assert.deepEqual(preferredOpenClawAnswers([latest,current]),[current])
  })
  it('does not start a run after queue lease abort', async () => {
    const mock = clientWith()
    let started = false
    mock.client.startRun = async () => { started = true; return { runId: 'run-9' } }
    await assert.rejects(applyWithOpenClaw({ ...input, signal: AbortSignal.abort() }, mock.client))
    assert.equal(started, false)
  })
  it('loads all owned host answers while excluding shared, other-user and credential rows', async () => {
    const base = { userId: 'owner', host: 'jobs.ashbyhq.com', confirmed: true, provenance: 'explicit_user' }
    const rows = [
      [ { ...base, label: 'Current employer', value: 'Fixture' }, { ...base, label: 'API key', value: 'NEVER_INCLUDE' }, { ...base, label: 'Phone', userId: 'other', value: 'OTHER_USER' }, { ...base, userId: null, label: 'Name', value: 'SHARED' }, { ...base, label: 'Work authorization in Canada', value: 'No' } ],
      [ { userId:'owner',host:'jobs.ashbyhq.com',attemptId:'attempt-9',label:'Are you legally authorized to work in the United States?',type:'checkbox',required:true,options:[],answer:'false',answerMeta:{source:'user'},answeredAt:null,remember:false,status:'failed'},
        { userId: 'owner', host: 'jobs.ashbyhq.com', attemptId: 'old-attempt', label: 'Gender', type: 'select', required: false, options: ['Male','Female'], answer: 'Female', answerMeta: { source: 'user' }, answeredAt: new Date(), remember: true, status: 'applied' },
        { userId: 'owner', host: 'jobs.ashbyhq.com', attemptId: 'old-attempt', label: 'Gender', type: 'select', required: false, options: ['Male','Female'], answer: 'Male', answerMeta: { source: 'profile_ai' }, answeredAt: new Date(), remember: true, status: 'applied' } ],
      [ { userId: 'owner', slot: 'target_titles', value: ['Engineer'], source: 'asked' }, { userId: 'owner', slot: 'access_token', value: 'NEVER_INCLUDE', source: 'asked' } ],
    ]
    let index = 0
    const database = { select: () => ({ from: () => ({ where: () => {const result=rows[index++];return Object.assign(Promise.resolve(result),{orderBy:()=>Promise.resolve(result)})} }) }) } as unknown as DatabaseTransaction
    const dossier = await runWithDatabase(database, () => loadOpenClawDossier('owner', 'attempt-9', ['jobs.ashbyhq.com']))
    assert.equal(dossier.answers.length, 4)
    assert.equal(dossier.answers.find(a=>a.type==='checkbox')?.source,'explicit_user')
    assert.equal(dossier.answers.find(a=>a.type==='checkbox')?.scope,'this_attempt')
    assert.equal(dossier.answers.find(a => a.label === 'Gender')?.value, 'Female')
    assert.equal(dossier.persona.length, 1)
    assert.doesNotMatch(JSON.stringify(dossier), /NEVER_INCLUDE|OTHER_USER|SHARED/)
  })
})
