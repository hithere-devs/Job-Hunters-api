import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { deterministicAnswer, deriveWorkRights, matchOption, semanticOf, validateModelAnswer, type CandidateDossier, type JobContext } from './answers.js'
import { planAnswers, storablePlan, unansweredRequired, type PlannerTransport } from './planner.js'
import { parseAshbyPayload } from './schema/ashby.js'
import { parseGreenhousePayload } from './schema/greenhouse.js'
import type { SchemaField } from './schema/types.js'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./schema/fixtures/${name}`, import.meta.url), 'utf8'))

export function dossier(overrides: Partial<CandidateDossier> = {}): CandidateDossier {
  return {
    fullName: 'Asha Rao', firstName: 'Asha', lastName: 'Rao', email: 'asha@example.com', phone: '+91 98765 43210', headline: 'Backend Engineer',
    location: { line1: '1 MG Road', line2: '', city: 'Bengaluru', region: 'Karnataka', postalCode: '560001', country: 'India', countryCode: 'IN' },
    links: { linkedin: 'https://linkedin.com/in/asha', github: 'https://github.com/asha', portfolio: '' },
    totalExperience: '5', currentCompany: 'Acme', currentTitle: 'Senior Engineer', noticePeriod: '30 days', currentCtc: '', expectedCtc: '',
    workMode: 'hybrid', relocate: 'Yes', workAuthorization: 'Yes', visaSponsorship: 'Required outside India', boundByAgreements: 'No',
    eeo: { gender: '', sexualOrientation: '', ethnicity: '', veteran: '', disability: '' },
    experience: [{ role: 'Senior Engineer', company: 'Acme', startedOn: '2021-01', endedOn: null, current: true, description: 'Built payments APIs in Go.' }],
    education: 'B.Tech Computer Science, IIT Madras, 2018', skills: ['Go', 'Postgres'], resumeText: 'Asha Rao\nBackend engineer...', savedAnswers: [],
    ...overrides,
  }
}
const usJob: JobContext = { title: 'Software Engineer', company: 'Mercor', location: 'San Francisco, CA', countries: ['US'], remote: false, description: 'Build systems.' }
const indiaJob: JobContext = { ...usJob, location: 'Bengaluru, India', countries: ['IN'] }
const field = (overrides: Partial<SchemaField>): SchemaField => ({ key: 'k', label: 'Label', kind: 'text', required: true, options: [], section: 'question', ...overrides })

describe('deterministic answers', () => {
  it('fills identity from My Kit and uploads the résumé', () => {
    const gh = parseGreenhousePayload(fixture('greenhouse-gitlab.json'), 'https://job-boards.greenhouse.io/gitlab/jobs/1')
    const byName = (name: string) => deterministicAnswer(gh.fields.find((f) => f.atsName === name)!, dossier(), usJob)!
    assert.deepEqual(byName('first_name').values, ['Asha'])
    assert.deepEqual(byName('email').values, ['asha@example.com'])
    assert.equal(byName('resume').action, 'upload_resume')
  })
  it('picks the country of residence from a 197-option list', () => {
    const gh = parseGreenhousePayload(fixture('greenhouse-gitlab.json'), 'https://job-boards.greenhouse.io/gitlab/jobs/1')
    const country = gh.fields.find((f) => /country of residence/i.test(f.label))!
    assert.equal(semanticOf(country), 'country')
    assert.deepEqual(deterministicAnswer(country, dossier(), usJob)!.values, ['India'])
  })
  it('never invents EEO answers: explicit Kit value, else decline, else ask', () => {
    const oa = parseAshbyPayload(fixture('ashby-openai.json'), 'https://jobs.ashbyhq.com/openai/x/application')
    const gender = oa.fields.find((f) => f.label === 'Gender')!
    assert.deepEqual(deterministicAnswer(gender, dossier(), usJob)!.values, ['Decline to self-identify'])
    assert.deepEqual(deterministicAnswer(gender, dossier({ eeo: { ...dossier().eeo, gender: 'Female' } }), usJob)!.values, ['Female'])
    const requiredNoDecline = field({ label: 'Gender', section: 'eeo', kind: 'select', options: [{ label: 'Male' }, { label: 'Female' }] })
    assert.equal(deterministicAnswer(requiredNoDecline, dossier(), usJob)!.action, 'ask')
  })
  it('derives sponsorship and authorisation only from explicit Kit facts', () => {
    const sponsor = field({ label: 'Will you now or in the future require sponsorship?', kind: 'boolean', options: [{ label: 'Yes' }, { label: 'No' }] })
    const auth = field({ label: 'Are you legally authorized to work in the country where the job is located?', kind: 'boolean', options: [{ label: 'Yes' }, { label: 'No' }] })
    assert.deepEqual(deterministicAnswer(sponsor, dossier(), usJob)!.values, ['Yes'])
    assert.deepEqual(deterministicAnswer(auth, dossier(), usJob)!.values, ['No'])
    assert.deepEqual(deterministicAnswer(sponsor, dossier(), indiaJob)!.values, ['No'])
    assert.deepEqual(deterministicAnswer(auth, dossier(), indiaJob)!.values, ['Yes'])
    assert.equal(deriveWorkRights(sponsor, dossier({ visaSponsorship: '' }), usJob), null)
    assert.equal(deriveWorkRights(sponsor, dossier(), { ...usJob, countries: ['US', 'GB'] }), null)
  })
  it('agrees to required acknowledgements and declines marketing', () => {
    const ack = field({ label: 'Applicant Arbitration Agreement Acknowledgement', kind: 'multiselect', options: [{ label: 'I acknowledge that I have read the Arbitration Agreement.' }] })
    assert.equal(deterministicAnswer(ack, dossier(), usJob)!.values[0], 'I acknowledge that I have read the Arbitration Agreement.')
    const sms = field({ label: 'Do you consent to receiving SMS text messages?', required: false, kind: 'select', options: [{ label: 'Yes - I consent' }, { label: 'No - I do not consent to receiving SMS text messages' }] })
    assert.match(deterministicAnswer(sms, dossier(), usJob)!.values[0]!, /^No/)
  })
  it('asks for a required link the Kit does not have instead of inventing one', () => {
    const portfolio = field({ label: 'Portfolio', kind: 'url' })
    assert.equal(deterministicAnswer(portfolio, dossier(), usJob)!.action, 'ask')
    assert.equal(deterministicAnswer({ ...portfolio, required: false }, dossier(), usJob)!.action, 'skip')
  })
  it('matches options by alias without guessing', () => {
    assert.equal(matchOption([{ label: 'Man' }, { label: 'Woman' }], ['Female', 'Woman'])?.label, 'Woman')
    assert.equal(matchOption([{ label: 'Male' }, { label: 'Female' }], ['Nonbinary']), null)
  })
})

describe('common screening questions without a model', () => {
  it('answers how-did-you-hear from the options', () => {
    const source = field({ label: 'How did you hear about this job?', kind: 'select', options: [{ label: 'Referral' }, { label: 'LinkedIn' }, { label: 'Other' }] })
    assert.deepEqual(deterministicAnswer(source, dossier(), usJob)!.values, ['LinkedIn'])
  })
  it('says No to previous employment unless the résumé shows the company', () => {
    const before = field({ label: 'Have you previously been employed at Mercor for any length of time?', kind: 'boolean', options: [{ label: 'Yes' }, { label: 'No' }] })
    assert.deepEqual(deterministicAnswer(before, dossier(), usJob)!.values, ['No'])
    const worked = dossier({ experience: [{ role: 'Engineer', company: 'Mercor', startedOn: null, endedOn: null, current: false, description: '' }] })
    assert.equal(deterministicAnswer(before, worked, usJob), null)
  })
  it('reads the long current-company label and accuracy acknowledgements', () => {
    assert.deepEqual(deterministicAnswer(field({ label: 'Please provide the name of your current (or most recent) company', kind: 'text' }), dossier(), usJob)!.values, ['Acme'])
    const confirm = field({ label: 'Please double-check all the information provided above. Ensuring accuracy is crucial.', kind: 'select', options: [{ label: 'I confirm' }] })
    assert.deepEqual(deterministicAnswer(confirm, dossier(), usJob)!.values, ['I confirm'])
  })
  it('treats "the country where you live" as the home jurisdiction', () => {
    const auth = field({ label: 'Are you authorized to work in the country where you live?', kind: 'boolean', options: [{ label: 'Yes' }, { label: 'No' }] })
    assert.deepEqual(deterministicAnswer(auth, dossier(), usJob)!.values, ['Yes'])
  })
})

describe('sponsorship with several yes options', () => {
  it('chooses the generic yes when the Kit says sponsorship is needed', () => {
    const sponsor = field({ label: 'Will you now or in the future require sponsorship for a visa?', kind: 'select', options: [{ label: 'No' }, { label: 'Yes, EU Blue Card' }, { label: 'Yes, but not one of the visas listed here' }] })
    assert.deepEqual(deterministicAnswer(sponsor, dossier(), usJob)!.values, ['Yes, but not one of the visas listed here'])
  })
})

describe('dropdowns whose options load on open', () => {
  it('types the value for a no-option select and lets the executor verify it', () => {
    const country = field({ label: 'Country', kind: 'select', options: [] })
    assert.deepEqual(deterministicAnswer(country, dossier(), usJob)!.values, ['India'])
    assert.deepEqual(validateModelAnswer(field({ label: 'Pick a city', kind: 'select', options: [] }), { action: 'fill', values: ['Bengaluru'], basis: 'model', confidence: 0.9 }).values, ['Bengaluru'])
  })
})

describe('model answer validation', () => {
  it('rejects a choice that is not an option', () => {
    const select = field({ kind: 'select', options: [{ label: 'Yes' }, { label: 'No' }] })
    assert.equal(validateModelAnswer(select, { action: 'fill', values: ['Maybe'], basis: 'model', confidence: 0.9 }).action, 'ask')
    assert.deepEqual(validateModelAnswer(select, { action: 'fill', values: ['yes'], basis: 'model', confidence: 0.9 }).values, ['Yes'])
  })
  it('refuses sensitive model guesses and turns a required skip into a question', () => {
    const criminal = field({ label: 'Have you ever been convicted of a felony?', kind: 'boolean', options: [{ label: 'Yes' }, { label: 'No' }] })
    assert.equal(validateModelAnswer(criminal, { action: 'fill', values: ['No'], basis: 'model', confidence: 0.95 }).action, 'ask')
    // Claiming a saved answer is not enough; one must exist and agree.
    assert.equal(validateModelAnswer(criminal, { action: 'fill', values: ['No'], basis: 'saved_answer', confidence: 0.95 }).action, 'ask')
    assert.equal(validateModelAnswer(criminal, { action: 'fill', values: ['No'], basis: 'saved_answer', confidence: 0.95 }, [{ question: 'Have you ever been convicted of a felony or crime?', answer: 'No', options: ['Yes', 'No'] }]).action, 'fill')
    assert.equal(validateModelAnswer(criminal, { action: 'fill', values: ['No'], basis: 'derived', confidence: 0.99 }).action, 'ask')
    assert.equal(validateModelAnswer(field({}), { action: 'skip', values: [], basis: 'model', confidence: 1 }).action, 'ask')
  })
  it('keeps low-confidence facts away from the form', () => {
    assert.equal(validateModelAnswer(field({ label: 'GPA' }), { action: 'fill', values: ['3.9'], basis: 'model', confidence: 0.4 }).action, 'ask')
  })
})

describe('planning', () => {
  const mercor = parseAshbyPayload(fixture('ashby-mercor.json'), 'https://jobs.ashbyhq.com/mercor/x/application')
  it('sends only non-deterministic fields to the model and validates its answers', async () => {
    let sent: Array<{ key: string; options?: string[] }> = []
    const transport: PlannerTransport = {
      async plan({ requestText }) {
        sent = JSON.parse(requestText.split('FORM FIELDS TO ANSWER (JSON)\n')[1]!)
        return {
          model: 'stub',
          output: {
            answers: sent.map((row) => /office/i.test(row.key) || row.options?.some((o) => /San Francisco HQ/.test(o))
              ? { key: row.key, action: 'fill' as const, values: row.options ?? [], basis: 'derived' as const, confidence: 0.9, reason: 'Willing to relocate; both offices.' }
              : { key: row.key, action: 'fill' as const, values: row.options?.length ? [row.options[0]!] : ['Yes'], basis: 'model' as const, confidence: 0.8, reason: 'stub' }),
          },
        }
      },
    }
    const plan = await planAnswers({ userId: 'u', schema: mercor, dossier: dossier(), job: usJob, transport })
    assert.ok(sent.every((row) => !/_systemfield_(?:name|email|resume)/.test(row.key)))
    const office = plan.answers.find((row) => /Which office/.test(row.label))!
    assert.equal(office.action, 'fill')
    assert.equal(office.values.length, 2)
    assert.equal(plan.answers.length, mercor.fields.length)
  })
  it('a missing planner turns open required questions into user questions', async () => {
    const plan = await planAnswers({ userId: 'u', schema: mercor, dossier: dossier(), job: usJob, transport: null })
    assert.ok(unansweredRequired(plan).length > 0)
    assert.ok(unansweredRequired(plan).every((row) => row.required))
  })
  it('redacts sensitive values before storage', () => {
    const stored = storablePlan({ fingerprint: 'f', model: 'm', createdAt: '', answers: [{ key: 'k', label: 'Race', kind: 'select', required: false, action: 'fill', values: ['Asian'], basis: 'kit', confidence: 1, sensitive: true }] })
    assert.deepEqual(stored.answers[0]!.values, ['[redacted]'])
  })
})
