import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { ashbyApplicationUrl, ashbyRefFromUrl, parseAshbyPayload } from './ashby.js'
import { loadGreenhouseSchema, parseGreenhousePayload } from './greenhouse.js'
import { loadPublishedSchema } from './index.js'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

describe('Greenhouse published schema', () => {
  const schema = parseGreenhousePayload(fixture('greenhouse-gitlab.json'), 'https://job-boards.greenhouse.io/gitlab/jobs/8860302002')
  it('keeps every question with its exact required flag', () => {
    const sponsorship = schema.fields.find((field) => /sponsorship/i.test(field.label))!
    assert.equal(sponsorship.required, true)
    assert.equal(sponsorship.kind, 'select')
    assert.equal(sponsorship.atsName, 'question_38624172002')
    assert.ok(sponsorship.options.some((option) => option.label === 'Yes, EU Blue Card'))
    assert.equal(schema.fields.find((field) => field.label === 'Phone')!.required, false)
  })
  it('treats Resume/CV as one required file field', () => {
    const resume = schema.fields.find((field) => field.fileRole === 'resume')!
    assert.equal(resume.kind, 'file')
    assert.equal(resume.required, true)
    assert.equal(schema.fields.filter((field) => field.atsName === 'resume_text').length, 0)
  })
  it('reads EEOC compliance questions with decline options', () => {
    const veteran = schema.fields.find((field) => field.atsName === 'veteran_status')!
    assert.equal(veteran.section, 'eeo')
    assert.ok(veteran.options.some((option) => /don't wish to answer/i.test(option.label)))
  })
  it('classifies profile fields and long country lists', () => {
    assert.equal(schema.fields.find((field) => field.atsName === 'email')!.kind, 'email')
    assert.equal(schema.fields.find((field) => field.atsName === 'first_name')!.section, 'profile')
    const country = schema.fields.find((field) => /country of residence/i.test(field.label))!
    assert.ok(country.options.length > 150)
  })
  it('is stable across parses', () => {
    const again = parseGreenhousePayload(fixture('greenhouse-gitlab.json'), schema.url)
    assert.equal(again.fingerprint, schema.fingerprint)
  })
  it('reads single-option acknowledgement questions', () => {
    const anthropic = parseGreenhousePayload(fixture('greenhouse-anthropic.json'), 'https://job-boards.greenhouse.io/anthropic/jobs/4461450008')
    const arbitration = anthropic.fields.find((field) => /Agreement to Arbitrate/.test(field.label))!
    assert.equal(arbitration.required, true)
    assert.equal(arbitration.options.length, 1)
  })
  it('a 404 from the questions API is a closed posting', async () => {
    const closed = await loadGreenhouseSchema('https://job-boards.greenhouse.io/acme/jobs/1', (async () => new Response('{}', { status: 404 })) as typeof fetch)
    assert.equal(closed?.closed, true)
  })
})

describe('Ashby published schema', () => {
  const schema = parseAshbyPayload(fixture('ashby-openai.json'), 'https://jobs.ashbyhq.com/openai/x/application')
  it('maps Ashby field types', () => {
    assert.equal(schema.fields.find((field) => field.atsName === '_systemfield_resume')!.fileRole, 'resume')
    assert.ok(schema.fields.some((field) => field.kind === 'location'))
    assert.ok(schema.fields.some((field) => field.kind === 'date'))
    const sponsorship = schema.fields.find((field) => /sponsorship/i.test(field.label))!
    assert.equal(sponsorship.kind, 'boolean')
    assert.deepEqual(sponsorship.options.map((option) => option.label), ['Yes', 'No'])
  })
  it('puts the EEOC survey in the eeo section', () => {
    const gender = schema.fields.find((field) => field.label === 'Gender')!
    assert.equal(gender.section, 'eeo')
    assert.ok(gender.options.some((option) => /decline/i.test(option.label)))
  })
  it('keeps multi-select office questions (top unanswered question in production)', () => {
    const mercor = parseAshbyPayload(fixture('ashby-mercor.json'), 'https://jobs.ashbyhq.com/mercor/x/application')
    const office = mercor.fields.find((field) => /Which office/i.test(field.label))!
    assert.equal(office.kind, 'multiselect')
    assert.equal(office.required, true)
    assert.equal(office.options.length, 2)
  })
  it('parses Ashby URLs', () => {
    assert.deepEqual(ashbyRefFromUrl('https://jobs.ashbyhq.com/openai/2b0b5d6e-1f5c-4d0e-9a2e-3e4f5a6b7c8d'), { org: 'openai', jobId: '2b0b5d6e-1f5c-4d0e-9a2e-3e4f5a6b7c8d' })
    assert.equal(ashbyApplicationUrl('https://jobs.ashbyhq.com/openai/2b0b5d6e-1f5c-4d0e-9a2e-3e4f5a6b7c8d'), 'https://jobs.ashbyhq.com/openai/2b0b5d6e-1f5c-4d0e-9a2e-3e4f5a6b7c8d/application')
    assert.equal(ashbyRefFromUrl('https://jobs.lever.co/x/1'), null)
  })
})

describe('schema loader', () => {
  it('falls back to null when the ATS API fails', async () => {
    const schema = await loadPublishedSchema(['https://job-boards.greenhouse.io/acme/jobs/1'], (async () => new Response('oops', { status: 500 })) as typeof fetch)
    assert.equal(schema, null)
  })
  it('returns null for an unknown ATS', async () => {
    assert.equal(await loadPublishedSchema(['https://jobs.lever.co/acme/1'], (async () => { throw new Error('must not fetch') }) as typeof fetch), null)
  })
})
