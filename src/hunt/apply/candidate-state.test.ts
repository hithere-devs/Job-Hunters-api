import assert from 'node:assert/strict'
import { test } from 'node:test'
import { candidateState, compactCandidate } from './candidate-state.js'
import type { PortalProfile } from '../portal-profile.js'

const profile = {
  fullName: 'Azhar Mahmood',
  email: 'azhar@example.com',
  phone: '+91 8317466251',
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
  links: { linkedin: 'https://linkedin.com/in/azhar', github: 'https://github.com/azhar', portfolio: '' },
  noticePeriod: '30 days',
  currentCtc: '',
  expectedCtc: '',
  workAuthorization: 'Yes',
  willingToRelocate: 'Yes',
  skills: ['typescript', 'node'],
  experience: [{
    role: 'Engineer',
    company: 'Acme',
    startedOn: '2023-01-01',
    endedOn: null,
    isCurrent: true,
    description: '',
  }],
  photoStoragePath: null,
  photoFileName: null,
  baseResume: { id: 'r1', fileName: 'cv.pdf', storagePath: 'x', mimeType: 'application/pdf' },
  resumeDocument: null,
} satisfies PortalProfile

test('candidateState splits the name and keeps job context', () => {
  const state = candidateState(profile, { title: 'Staff Engineer', company: 'Atlan', location: 'Remote' })
  assert.equal(state.first_name, 'Azhar')
  assert.equal(state.last_name, 'Mahmood')
  assert.equal(state.job?.title, 'Staff Engineer')
  const compact = compactCandidate(state)
  assert.equal(compact.email, 'azhar@example.com')
  assert.equal(compact.city, 'Bengaluru')
  assert.equal((compact.current_role as { company: string }).company, 'Acme')
})
