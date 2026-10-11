import type { CandidateDossier, JobContext } from '../answers.js'

/** A synthetic candidate for fixtures. No real person's data. */
export function fixtureDossier(overrides: Partial<CandidateDossier> = {}): CandidateDossier {
  return {
    fullName: 'Asha Rao', firstName: 'Asha', lastName: 'Rao', email: 'asha@example.com', phone: '+91 98765 43210', headline: 'Backend Engineer',
    location: { line1: '1 MG Road', line2: '', city: 'Bengaluru', region: 'Karnataka', postalCode: '560001', country: 'India', countryCode: 'IN' },
    links: { linkedin: 'https://linkedin.com/in/asha', github: 'https://github.com/asha', portfolio: '' },
    totalExperience: '5', currentCompany: 'Acme', currentTitle: 'Senior Engineer', noticePeriod: '30 days', currentCtc: '', expectedCtc: '',
    workMode: 'hybrid', relocate: 'Yes', workAuthorization: 'Yes', visaSponsorship: 'Required outside India', boundByAgreements: 'No',
    eeo: { gender: '', sexualOrientation: '', ethnicity: '', veteran: '', disability: '' },
    experience: [{ role: 'Senior Engineer', company: 'Globex', startedOn: '2021-01', endedOn: null, current: true, description: 'Built payments APIs in Go.' }],
    education: 'B.Tech Computer Science, IIT Madras, 2018', skills: ['Go', 'Postgres'], resumeText: 'Asha Rao\nBackend engineer building payments APIs in Go.', savedAnswers: [],
    ...overrides,
  }
}

export const berlinJob: JobContext = { title: 'Senior Backend Engineer', company: 'Acme', location: 'Berlin, Germany', countries: ['DE'], remote: false, description: 'Payments infrastructure in Go.' }
export const usJob: JobContext = { title: 'Software Engineer', company: 'Mercor', location: 'San Francisco, CA', countries: ['US'], remote: false, description: 'Build systems.' }
