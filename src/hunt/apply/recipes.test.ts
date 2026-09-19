import assert from 'node:assert/strict'
import test from 'node:test'
import { coalesceOptionFields, cleanFieldLabel, correctedFieldLabel, embeddedGreenhouseApplicationUrl, greenhouseEmbedApplicationUrl, greenhouseFromListingUrl, greenhouseJobBoardUrl, greenhouseJobPathUrl, greenhousePostingGoneUrl, recipeFor, recipeForPage, resolveApplyUrl } from './recipes.js'

test('accepts the official embedded Greenhouse application URL', () => {
  const source = 'https://job-boards.greenhouse.io/embed/job_app?for=mongodb&token=8089859'
  assert.equal(embeddedGreenhouseApplicationUrl(source), source)
})

test('rejects lookalike, insecure, and unrelated iframe URLs', () => {
  assert.equal(embeddedGreenhouseApplicationUrl('https://greenhouse.io.evil.example/embed/job_app?token=1'), null)
  assert.equal(embeddedGreenhouseApplicationUrl('http://job-boards.greenhouse.io/embed/job_app?token=1'), null)
  assert.equal(embeddedGreenhouseApplicationUrl('https://job-boards.greenhouse.io/embed/other?token=1'), null)
})

test('rejects an absent or malformed iframe URL', () => {
  assert.equal(embeddedGreenhouseApplicationUrl(null), null)
  assert.equal(embeddedGreenhouseApplicationUrl('not a url'), null)
})

test('repairs a GDPR checkbox that inherited the resume upload label', () => {
  assert.equal(correctedFieldLabel({ label: 'Resume/CV*', type: 'checkbox', name: 'gdpr_demographic_data_consent_given', required: true }), 'Consent to processing applicant data')
})

test('builds a Greenhouse job-board form URL from token:id', () => {
  assert.equal(greenhouseJobBoardUrl('elastic:8154997'), 'https://job-boards.greenhouse.io/elastic/jobs/8154997')
  assert.equal(greenhouseJobBoardUrl('gitlab:8775507002'), 'https://job-boards.greenhouse.io/gitlab/jobs/8775507002')
  assert.equal(greenhouseJobBoardUrl('not-greenhouse'), null)
})

test('prefers a Greenhouse form URL over a custom-domain listing', () => {
  assert.equal(
    resolveApplyUrl({
      jobApplyUrl: 'https://jobs.elastic.co/jobs/8154997',
      sourceApplyUrl: 'https://jobs.elastic.co/jobs/8154997',
      canonicalUrl: 'https://jobs.elastic.co/jobs/8154997',
      sourceId: 'elastic:8154997',
    }),
    'https://job-boards.greenhouse.io/embed/job_app?for=elastic&token=8154997',
  )
})

test('builds a Greenhouse form URL from gh_jid on a career listing', () => {
  assert.equal(
    resolveApplyUrl({
      jobApplyUrl: 'https://jobs.elastic.co/jobs?gh_jid=8154997&gh_jid=8154997',
      sourceId: 'elastic:8154997',
    }),
    'https://job-boards.greenhouse.io/embed/job_app?for=elastic&token=8154997',
  )
  assert.equal(
    resolveApplyUrl({
      jobApplyUrl: 'https://www.mongodb.com/careers/job/?gh_jid=8089859',
      sourceId: 'mongodb:8089859',
    }),
    'https://job-boards.greenhouse.io/embed/job_app?for=mongodb&token=8089859',
  )
  assert.equal(
    greenhouseFromListingUrl('https://jobs.elastic.co/jobs?gh_jid=8154997&gh_jid=8154997'),
    'https://job-boards.greenhouse.io/elastic/jobs/8154997',
  )
  assert.equal(
    greenhouseFromListingUrl('https://www.mongodb.com/careers/job/?gh_jid=8089859'),
    'https://job-boards.greenhouse.io/mongodb/jobs/8089859',
  )
})

test('opens the Greenhouse embed application, not the career listing', () => {
  assert.equal(
    greenhouseEmbedApplicationUrl('mongodb:8089859'),
    'https://job-boards.greenhouse.io/embed/job_app?for=mongodb&token=8089859',
  )
  assert.equal(
    greenhouseJobPathUrl('https://job-boards.greenhouse.io/embed/job_app?for=mongodb&token=8089859'),
    true,
  )
  assert.equal(greenhousePostingGoneUrl('https://job-boards.greenhouse.io/embed/job_board?for=gitlab&error=true'), true)
  assert.equal(greenhousePostingGoneUrl('https://job-boards.greenhouse.io/embed/job_app?for=mongodb&token=8089859'), false)
})

test('strips Start typing placeholder noise from combobox labels', () => {
  assert.equal(cleanFieldLabel('Start typing... How did you hear about this job?*'), 'How did you hear about this job?*')
  assert.equal(cleanFieldLabel('How did you hear about this job?* Start typing...'), 'How did you hear about this job?*')
})

test('merges consecutive Ashby Yes/No option labels into one consent field', () => {
  const merged = coalesceOptionFields([
    { label: 'Cover Letter*', type: 'textarea', required: true },
    { label: 'Yes - I consent to receiving SMS text messages', type: 'radio', required: false },
    { label: 'No - I do not consent to receiving SMS text messages', type: 'radio', required: false },
    { label: 'Yes - I consent to receiving WhatsApp messages', type: 'radio', required: false },
    { label: 'No - I do not consent to receiving WhatsApp messages', type: 'radio', required: false },
    { label: 'How did you hear about this job?*', type: 'combobox', required: true },
  ])
  assert.deepEqual(merged.map((field) => field.label), [
    'Cover Letter*',
    'SMS text message consent',
    'WhatsApp message consent',
    'How did you hear about this job?*',
  ])
  assert.equal(merged[1]?.type, 'radio')
  assert.equal(merged[1]?.options?.[0]?.startsWith('Yes'), true)
  assert.equal(merged[1]?.options?.[1]?.startsWith('No'), true)
})

test('Ashby success copy with successfully submitted is a confirmation', () => {
  const recipe = recipeFor('https://jobs.ashbyhq.com/atlan/9ba81415-2033-4b72-af4a-d9d2f288abaa/application')
  assert.ok(recipe)
  assert.equal(recipe!.id, 'ashby')
  assert.equal(recipe!.success.test('Success Your application was successfully submitted.'), true)
})

test('SmartRecruiters and Workable have apply recipes', () => {
  const sr = recipeFor('https://jobs.smartrecruiters.com/Sodexo/744000150006939')
  assert.ok(sr)
  assert.equal(sr!.id, 'smartrecruiters')
  const workable = recipeFor('https://apply.workable.com/huntress/j/ABC123/')
  assert.ok(workable)
  assert.equal(workable!.id, 'workable')
})

test('aggregator hops pick the live ATS recipe', () => {
  const hopped = recipeForPage(
    'https://remotive.com/remote-jobs/software-dev/foo-123',
    'https://job-boards.greenhouse.io/embed/job_app?for=mongodb&token=8089859',
  )
  assert.equal(hopped?.id, 'greenhouse')
})
