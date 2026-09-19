import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyApplyQuestion, kitSuggestion } from './apply-preferences.js'
import { candidateState } from './candidate-state.js'
import type { PortalProfile } from '../portal-profile.js'

const profile = {
  fullName: 'Azhar Mahmood',
  email: 'a@example.com',
  phone: '1',
  headline: '',
  address: { line1: '', line2: '', city: 'Bangalore', region: '', postalCode: '', country: 'India' },
  links: { linkedin: '', github: '', portfolio: '' },
  noticePeriod: '',
  currentCtc: '',
  expectedCtc: '',
  workAuthorization: 'India',
  willingToRelocate: 'Yes',
  visaSponsorship: 'Required outside India',
  workMode: 'hybrid',
  gender: 'Male',
  sexualOrientation: 'Heterosexual / Straight',
  ethnicity: 'Indian',
  veteranStatus: 'I am not a protected veteran',
  disabilityStatus: 'No, I do not have a disability',
  boundByAgreements: 'No',
  skills: [],
  experience: [],
  photoStoragePath: null,
  photoFileName: null,
  baseResume: { id: 'r1', fileName: 'cv.pdf', storagePath: 'x', mimeType: 'application/pdf' },
  resumeDocument: null,
} satisfies PortalProfile

test('Harvey hybrid copy is currently-based-in, not office-days willingness', () => {
  const label = 'This role is tied to the office location listed in the job posting. Team members are expected to work from the office 3 days per week as part of Harvey’s hybrid work model. Are you currently based in the listed location and able to work in person 3 days per week?'
  assert.equal(classifyApplyQuestion(label), 'based_in')
  const candidate = candidateState(profile, { title: 'Engineer', company: 'Harvey', location: 'San Francisco; New York' })
  const picked = kitSuggestion({
    label,
    options: ['Yes, I can work in person 3 days per week', "No, I'm only able to work remotely", 'Other (optional context)'],
    candidate,
  })
  assert.equal(picked.kind, 'based_in')
  assert.match(picked.value ?? '', /no/i)
})

test('Reddit candidate privacy I-agree is eeo consent, not a human pause', () => {
  const label = 'By selecting "I agree," I understand that the information I have provided as part of this job application will be processed in accordance with Reddit\'s Candidate Privacy Policy.'
  assert.equal(classifyApplyQuestion(label), 'eeo_consent')
  const candidate = candidateState(profile, { title: 'Engineer', company: 'Reddit', location: 'Remote - United States' })
  assert.equal(kitSuggestion({ label, options: ['I agree'], candidate }).value, 'I agree')
  const box = 'By checking this box, I consent to Reddit collecting, storing, and processing my responses to the demographic data surveys above.'
  assert.equal(classifyApplyQuestion(box), 'eeo_consent')
  assert.equal(kitSuggestion({ label: box, options: [], candidate }).value, 'true')
})

test('transgender experience uses kit No, not a human pause', () => {
  const label = 'Are you a person of transgender experience?'
  assert.equal(classifyApplyQuestion(label), 'transgender')
  const candidate = candidateState(profile, { title: 'Engineer', company: 'Reddit', location: 'Remote' })
  assert.equal(kitSuggestion({ label, options: ['Yes', 'No'], candidate }).value, 'No')
})

test('how did you hear uses kit LinkedIn, not a human pause', () => {
  const label = 'How did you hear about this job?'
  assert.equal(classifyApplyQuestion(label), 'referral')
  const candidate = candidateState(profile, { title: 'Engineer', company: 'Reddit', location: 'Remote' })
  assert.equal(kitSuggestion({ label, options: ['LinkedIn', 'Indeed', 'Other'], candidate }).value, 'LinkedIn')
  assert.equal(kitSuggestion({ label, options: [], candidate }).value, 'LinkedIn')
})

test('student and new-grad start date use kit, not a human pause', () => {
  assert.equal(classifyApplyQuestion('Are you a Student or New Grad?'), 'student')
  assert.equal(classifyApplyQuestion('If yes, when is your earliest start date?'), 'start_date')
  const candidate = candidateState(profile, { title: 'Software Engineer, Marketplace', company: 'Mercor', location: 'San Francisco' })
  assert.equal(kitSuggestion({ label: 'Are you a Student or New Grad?', options: ['Yes', 'No'], candidate }).value, 'No')
  assert.equal(kitSuggestion({
    label: 'If yes, when is your earliest start date?',
    options: ['Immediately/next few months, full-time', 'Winter 2025 (upon graduation)', 'I am not a New Grad'],
    candidate,
  }).value, 'I am not a New Grad')
})

test('Indian ethnicity does not match American Indian; veteran No does not match Other Protected Veteran', () => {
  const candidate = candidateState(profile, { title: 'Engineer', company: 'Reddit', location: 'Remote - United States' })
  assert.equal(kitSuggestion({
    label: 'Please select up to 2 ethnicities that you most closely identify with.',
    options: ['American Indian or Alaska Native', 'Asian', 'Black or African American', 'White'],
    candidate,
  }).value, 'Asian')
  assert.equal(kitSuggestion({
    label: 'I identify my race/ethnicity as (please mark all that apply):',
    options: ['Native American', 'American Indian', 'Asian', 'White'],
    candidate,
  }).value, 'Asian')
  assert.equal(kitSuggestion({
    label: 'Please select up to 2 ethnicities that you most closely identify with.',
    options: [],
    candidate,
  }).value, 'Asian')
  assert.equal(kitSuggestion({
    label: 'Please select up to 2 ethnicities that you most closely identify with.',
    options: ['East Asian', 'South Asian', 'Southeast Asian', 'White', 'Black or African American'],
    candidate,
  }).value, 'South Asian')
  assert.equal(kitSuggestion({
    label: 'Veteran Status:',
    options: ['Unspecified Veteran', 'I identify as a protected veteran', 'I am not a protected veteran'],
    candidate,
  }).value, 'I am not a protected veteran')
  assert.equal(kitSuggestion({
    label: 'Are you a veteran/have you served in the military?',
    options: ['Vietnam Era Veteran', 'I am not a protected veteran', 'I identify as a protected veteran'],
    candidate,
  }).value, 'I am not a protected veteran')
  assert.equal(kitSuggestion({
    label: 'Are you a veteran/have you served in the military?',
    options: ['Inactive Reserve', 'Other Protected Veteran', 'Unspecified Veteran', 'Vietnam Era Veteran', 'No military service', "I don't wish to answer"],
    candidate,
  }).value, 'No military service')
  assert.equal(kitSuggestion({
    label: 'Are you a veteran/have you served in the military?',
    options: ['I identify as a protected veteran', 'I am not a protected veteran', 'Other Protected Veteran'],
    candidate,
  }).value, 'I am not a protected veteran')
  assert.equal(kitSuggestion({
    label: 'Veteran Status:',
    options: [],
    candidate,
  }).value, 'I am not a protected veteran')
})

test('classifies sponsorship, demographics, and office questions', () => {
  assert.equal(classifyApplyQuestion('Will you now or in the future require employment visa sponsorship?'), 'sponsorship')
  assert.equal(classifyApplyQuestion('Are you legally authorized to work in the country where the job is located?'), 'work_auth')
  assert.equal(classifyApplyQuestion('Are you currently authorized to work in the U.S.?'), 'work_auth')
  assert.equal(classifyApplyQuestion('Do you now, or will you in the future, require immigration sponsorship to work at Reddit?'), 'sponsorship')
  assert.equal(classifyApplyQuestion('What gender identity do you most closely identify with?'), 'gender')
  assert.equal(classifyApplyQuestion('What sexual orientation do you most closely identify with?'), 'orientation')
  assert.equal(classifyApplyQuestion('I identify my race/ethnicity as (please mark all that apply):'), 'ethnicity')
  assert.equal(classifyApplyQuestion('Veteran Status:'), 'veteran')
  assert.equal(classifyApplyQuestion('Are you currently bound by any agreements with a current or former employer'), 'noncompete')
  assert.equal(classifyApplyQuestion('Mercor follows an on-site work culture. Are you willing to work in the office Monday-Friday?'), 'office_days')
  assert.equal(classifyApplyQuestion('If you are not currently in Austin, are you willing to relocate to Austin?'), 'office_days')
  assert.equal(classifyApplyQuestion('From where do you intend to work?'), 'which_office')
  assert.equal(classifyApplyQuestion('What is your preferred office location?'), 'which_office')
  assert.equal(classifyApplyQuestion('Do you currently live or are you willing to relocate to the job’s location?'), 'office_days')
  assert.equal(classifyApplyQuestion('Please review and acknowledge the Robinhood Applicant Privacy Policy'), 'eeo_consent')
  assert.equal(classifyApplyQuestion('Which office are you applying to? (Select both if appropriate)'), 'which_office')
  assert.equal(classifyApplyQuestion('Country'), 'phone_country')
  assert.equal(classifyApplyQuestion('Phone country code'), 'phone_country')
})

test('India job does not need sponsorship; US jobs need sponsorship and are authorized', () => {
  const india = candidateState(profile, { title: 'Engineer', company: 'Local', location: 'Bengaluru, India' })
  const us = candidateState(profile, { title: 'Engineer', company: 'Harvey', location: 'San Francisco, CA' })
  const remoteUs = candidateState(profile, { title: 'Engineer', company: 'Reddit', location: 'Remote - United States' })
  const sponsorIndia = kitSuggestion({ label: 'Will you now or in the future require employment visa sponsorship?', options: ['Yes', 'No'], candidate: india })
  const sponsorUs = kitSuggestion({ label: 'Will you now or in the future require employment visa sponsorship?', options: ['Yes', 'No'], candidate: us })
  const authUs = kitSuggestion({ label: 'Are you legally authorized to work in the country where the job is located?', options: ['Yes', 'No'], candidate: us })
  const authUsWording = kitSuggestion({ label: 'Are you currently authorized to work in the U.S.?', options: ['Yes', 'No'], candidate: remoteUs })
  const sponsorRemoteUs = kitSuggestion({ label: 'Do you now, or will you in the future, require immigration sponsorship to work at Reddit?', options: ['Yes', 'No'], candidate: remoteUs })
  assert.equal(sponsorIndia.value, 'No')
  assert.equal(sponsorUs.value, 'Yes')
  assert.equal(authUs.value, 'Yes')
  assert.equal(authUsWording.value, 'Yes')
  assert.equal(sponsorRemoteUs.value, 'Yes')
  const saudi = candidateState(profile, { title: 'Engineer', company: 'Scale AI', location: 'Riyadh, Saudi Arabia' })
  assert.equal(kitSuggestion({
    label: 'Are you legally authorized to work in the country where the job is located?',
    options: ['Yes', 'No'],
    candidate: saudi,
  }).value, 'Yes')
  assert.equal(kitSuggestion({
    label: 'From where do you intend to work?',
    candidate: remoteUs,
  }).value, 'Bangalore')
})

test('demographics pick closest kit values', () => {
  const candidate = candidateState(profile, { title: 'Engineer', company: 'Scale AI', location: 'San Francisco' })
  assert.equal(kitSuggestion({ label: 'Gender identity', options: ['Woman', 'Man', 'Non-binary'], candidate }).value, 'Man')
  assert.equal(kitSuggestion({ label: 'Sexual orientation', options: ['Heterosexual or Straight', 'Gay', 'Lesbian'], candidate }).value, 'Heterosexual or Straight')
  assert.equal(kitSuggestion({ label: 'Race/ethnicity', options: ['White', 'Asian', 'Black or African American'], candidate }).value, 'Asian')
  assert.equal(kitSuggestion({ label: 'Veteran Status', options: ['I identify as a protected veteran', 'I am not a protected veteran'], candidate }).value, 'I am not a protected veteran')
  assert.equal(kitSuggestion({ label: 'bound by any agreements with a current or former employer', options: ['Yes', 'No'], candidate }).value, 'No')
  assert.equal(kitSuggestion({ label: 'work in the office Monday-Friday', options: ['Yes', 'No'], candidate }).value, 'Yes')
})

test('phone country code is India +91, not the job office country', () => {
  const candidate = candidateState(profile, { title: 'Engineer', company: 'Scale AI', location: 'Riyadh, Saudi Arabia' })
  const picked = kitSuggestion({
    label: 'Country',
    options: ['Bahrain +973', 'India +91', 'Saudi Arabia +966', 'United States +1'],
    candidate,
  })
  assert.equal(picked.kind, 'phone_country')
  assert.equal(picked.value, 'India +91')
})
