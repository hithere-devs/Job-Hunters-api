import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectSchemaFields,
  greenhouseBoardFromUrl,
  greenhouseJobMissing,
  mergeGreenhouseSchema,
} from './greenhouse-schema.js'

test('parses Greenhouse embed and job-path URLs', () => {
  assert.deepEqual(
    greenhouseBoardFromUrl('https://job-boards.greenhouse.io/embed/job_app?for=mongodb&token=8089859'),
    { token: 'mongodb', jobId: '8089859' },
  )
  assert.deepEqual(
    greenhouseBoardFromUrl('https://job-boards.greenhouse.io/gitlab/jobs/8775507002'),
    { token: 'gitlab', jobId: '8775507002' },
  )
  assert.equal(greenhouseBoardFromUrl('https://jobs.ashbyhq.com/render'), null)
})

test('merges demographic decline options onto inventory fields', () => {
  const merged = mergeGreenhouseSchema(
    [
      { label: 'Gender*', type: 'combobox', required: true },
      { label: 'Hispanic/Latino*', type: 'combobox', required: true },
      { label: 'Gender Identity*', type: 'combobox', required: true },
    ],
    [
      { label: 'Gender', required: false, options: ['Male', 'Female', "I don't wish to answer"] },
      { label: 'Gender Identity', required: false, options: ['Man', 'Woman', "I don't wish to answer"] },
      { label: 'Are you Hispanic/Latino?', required: false, options: ['Yes', 'No', "I don't wish to answer"] },
    ],
  )
  assert.equal(merged[0]?.options?.[2], "I don't wish to answer")
  assert.equal(merged[1]?.options?.[2], "I don't wish to answer")
  assert.equal(merged[2]?.options?.[0], 'Man')
})

test('keeps location questions that also carry hidden lat/lon', () => {
  const fields = collectSchemaFields({
    location_questions: [{
      label: 'Location',
      required: true,
      fields: [
        { name: 'longitude', type: 'input_hidden' },
        { name: 'latitude', type: 'input_hidden' },
        { name: 'location', type: 'input_text' },
      ],
    }],
  })
  assert.equal(fields[0]?.label, 'Location')
  assert.equal(fields[0]?.name, 'location')
})

test('Greenhouse job API 404 is missing', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response('{"error":"Job not found"}', { status: 404 })) as typeof fetch
  try {
    assert.equal(await greenhouseJobMissing('https://job-boards.greenhouse.io/gitlab/jobs/8775507002'), true)
  } finally {
    globalThis.fetch = original
  }
})
