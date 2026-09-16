import assert from 'node:assert/strict'
import test from 'node:test'
import { embeddedGreenhouseApplicationUrl } from './recipes.js'

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
