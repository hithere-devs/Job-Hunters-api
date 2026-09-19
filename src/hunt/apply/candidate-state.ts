import type { PortalProfile } from '../portal-profile.js'
import { applyPreferencesFromKit, type ApplyPreferences } from './apply-preferences.js'

export interface JobContext {
  title?: string
  role?: string
  company?: string
  location?: string | null
  description?: string | null
}

export interface CandidateState {
  name: string
  first_name: string
  last_name: string
  email: string
  phone: string
  headline: string
  location: {
    line1: string
    line2: string
    city: string
    region: string
    postal_code: string
    country: string
  }
  links: {
    linkedin: string
    github: string
    portfolio: string
  }
  experience_years: string
  work_authorization: string
  relocate: string
  notice_period: string
  current_ctc: string
  expected_ctc: string
  skills: string[]
  experience: Array<{
    role: string
    company: string
    started_on: string | null
    ended_on: string | null
    current: boolean
  }>
  job?: {
    title: string
    company: string
    location: string | null
    description?: string
  }
  preferences: ApplyPreferences
}

function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: '', last: '' }
  if (parts.length === 1) return { first: parts[0]!, last: '' }
  return { first: parts[0]!, last: parts.slice(1).join(' ') }
}

export function candidateState(profile: PortalProfile, job?: JobContext): CandidateState {
  const { first, last } = splitName(profile.fullName)
  return {
    name: profile.fullName,
    first_name: first,
    last_name: last,
    email: profile.email,
    phone: profile.phone,
    headline: profile.headline,
    location: {
      line1: profile.address.line1,
      line2: profile.address.line2,
      city: profile.address.city,
      region: profile.address.region,
      postal_code: profile.address.postalCode,
      country: profile.address.country,
    },
    links: profile.links,
    experience_years: profile.totalExperience ?? '',
    work_authorization: profile.workAuthorization,
    relocate: profile.willingToRelocate,
    notice_period: profile.noticePeriod,
    current_ctc: profile.currentCtc,
    expected_ctc: profile.expectedCtc,
    skills: profile.skills.slice(0, 24),
    experience: profile.experience.slice(0, 5).map((row) => ({
      role: row.role,
      company: row.company,
      started_on: row.startedOn,
      ended_on: row.endedOn,
      current: row.isCurrent,
    })),
    ...(job
      ? {
          job: {
            title: job.title ?? job.role ?? '',
            company: job.company ?? '',
            location: job.location ?? null,
            description: (job.description ?? '').slice(0, 1200),
          },
        }
      : {}),
    preferences: applyPreferencesFromKit(profile),
  }
}

export function compactCandidate(state: CandidateState): Record<string, unknown> {
  return {
    name: state.name,
    first_name: state.first_name,
    last_name: state.last_name,
    email: state.email,
    phone: state.phone,
    headline: state.headline,
    city: state.location.city,
    region: state.location.region,
    country: state.location.country,
    address: state.location.line1,
    postal_code: state.location.postal_code,
    linkedin: state.links.linkedin,
    github: state.links.github,
    website: state.links.portfolio,
    experience_years: state.experience_years,
    work_authorization: state.work_authorization,
    relocate: state.relocate,
    notice_period: state.notice_period,
    skills: state.skills,
    current_role: state.experience.find((row) => row.current) ?? state.experience[0] ?? null,
    job: state.job
      ? {
          title: state.job.title,
          company: state.job.company,
          location: state.job.location,
          description: (state.job.description ?? '').slice(0, 700),
        }
      : null,
    preferences: state.preferences,
    kit_overrides_review_answers: true,
  }
}
