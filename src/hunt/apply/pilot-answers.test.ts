import assert from 'node:assert/strict'
import { test } from 'node:test'
import { candidateState } from './candidate-state.js'
import { pickOptionWithJev, profileValue, resolvePilotAnswer } from './pilot-answers.js'
import type { PortalProfile } from '../portal-profile.js'
import type { PilotElement } from './pilot-page.js'
import type { JevResponse } from './jev-client.js'

const profile = {
  fullName: 'Azhar Mahmood',
  email: 'azhar@example.com',
  phone: '+918317466251',
  headline: 'Backend engineer',
  totalExperience: '3',
  address: {
    line1: '1 Street',
    line2: '',
    city: 'Bengaluru',
    region: 'Karnataka',
    postalCode: '560001',
    country: 'India',
  },
  links: { linkedin: 'https://linkedin.com/in/azhar', github: '', portfolio: '' },
  noticePeriod: '',
  currentCtc: '',
  expectedCtc: '',
  workAuthorization: 'India — no US work authorization',
  willingToRelocate: 'Yes',
  skills: [],
  experience: [],
  photoStoragePath: null,
  photoFileName: null,
  baseResume: { id: 'r1', fileName: 'cv.pdf', storagePath: 'x', mimeType: 'application/pdf' },
  resumeDocument: null,
} satisfies PortalProfile

function field(partial: Partial<PilotElement> & Pick<PilotElement, 'label' | 'role'>): PilotElement {
  return {
    id: 'e1',
    required: true,
    value: '',
    filled: false,
    options: [],
    enabled: true,
    ...partial,
  }
}

test('profileValue only suggests facts; it does not decide the form', () => {
  const candidate = candidateState(profile, { title: 'Staff Engineer', company: 'Atlan', location: 'Bengaluru' })
  assert.equal(profileValue(field({ label: 'Full Name', role: 'textbox' }), candidate), 'Azhar Mahmood')
  assert.equal(profileValue(field({ label: 'Email', role: 'email' }), candidate), 'azhar@example.com')
})

test('Jev picks the city option to click from the open dropdown, not ArrowDown', async () => {
  const candidate = candidateState(profile, { title: 'Engineer', company: 'Reddit', location: 'Remote - United States' })
  const picked = await pickOptionWithJev({
    element: field({
      label: 'Location (City)',
      role: 'combobox',
      options: ['Bangkok, Thailand', 'Bangalore, Karnataka, India', 'Bangor, Maine, United States'],
    }),
    candidate,
    userId: '00000000-0000-4000-8000-000000000001',
    decide: async () => ({
      model: 'jev-latest',
      answers: { pick: { type: 'choice', choice: 'o1' } },
    }),
  })
  assert.equal(picked, 'Bangalore, Karnataka, India')
})

test('Jev decides a choice for this job, not a generic decline', async () => {
  const candidate = candidateState(profile, { title: 'Backend Engineer', company: 'PostHog', location: 'Remote' })
  const element = field({
    label: 'How did you hear about this job?',
    role: 'select',
    options: ['LinkedIn', 'Other'],
  })
  const decided = await resolvePilotAnswer({
    element,
    candidate,
    userId: '00000000-0000-4000-8000-000000000001',
    decide: async () => ({
      model: 'jev-latest',
      answers: { pick: { type: 'choice', choice: 'o1' } },
    } satisfies JevResponse),
  })
  assert.equal(decided.value, 'LinkedIn')
  assert.equal(decided.source, 'profile')
})

test('kit answers classified legal questions even when Jev asks to park', async () => {
  const candidate = candidateState(profile, { title: 'Engineer', company: 'Scale AI', location: 'Riyadh, Saudi Arabia' })
  const decided = await resolvePilotAnswer({
    element: field({
      label: 'Are you legally authorized to work in the country where the job is located?',
      role: 'select',
      options: ['Yes', 'No'],
    }),
    candidate,
    userId: '00000000-0000-4000-8000-000000000001',
    decide: async () => {
      throw new Error('Jev must not be called for a kit-classified field')
    },
  })
  assert.equal(decided.value, 'Yes')
  assert.equal(decided.source, 'profile')
})

test('Jev can refuse a profile suggestion that does not fit this job', async () => {
  const candidate = candidateState(profile, { title: 'US-only role', company: 'Acme', location: 'United States' })
  const decided = await resolvePilotAnswer({
    element: field({ label: 'City', role: 'textbox' }),
    candidate,
    userId: '00000000-0000-4000-8000-000000000001',
    decide: async () => ({
      model: 'jev-latest',
      answers: { action: { type: 'choice', choice: 'ask' } },
    } satisfies JevResponse),
  })
  assert.equal(decided.value, null)
  assert.equal(decided.reason, 'unknown_field')
})
