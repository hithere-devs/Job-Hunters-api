import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../../../db/client.js'
import { pendingApplicationQuestions } from '../../../db/schema.js'
import type { PortalProfile } from '../../portal-profile.js'
import { countryCodeFor } from '../work-authorisation.js'
import type { CandidateDossier, JobContext } from './answers.js'

function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') }
}

/**
 * A résumé parse sometimes stores the role description as the company
 * ("Leading full stack and AI Infrastructure development for Samora AI.").
 * Keep a name; recover one from "…for/at X"; otherwise leave it empty so the
 * question is asked rather than answered with a sentence.
 */
export function companyName(raw: string): string {
  const value = raw.trim().replace(/\.$/, '')
  if (value.split(/\s+/).length <= 5) return value
  const named = /\b(?:for|at|with)\s+([A-Z][\w&.'-]*(?:\s+[A-Z0-9][\w&.'-]*){0,4})\s*$/.exec(value)
  return named?.[1]?.trim() ?? ''
}

export function dossierFromProfile(profile: PortalProfile, savedAnswers: CandidateDossier['savedAnswers'] = []): CandidateDossier {
  const { first, last } = splitName(profile.fullName)
  const current = profile.experience.find((row) => row.isCurrent) ?? profile.experience[0]
  return {
    fullName: profile.fullName,
    firstName: first,
    lastName: last,
    email: profile.email,
    phone: profile.phone,
    headline: profile.headline,
    location: {
      line1: profile.address.line1,
      line2: profile.address.line2,
      city: profile.address.city,
      region: profile.address.region,
      postalCode: profile.address.postalCode,
      country: profile.address.country,
      countryCode: countryCodeFor(profile.address.country),
    },
    links: profile.links,
    totalExperience: profile.totalExperience ?? '',
    currentCompany: companyName(current?.company ?? ''),
    currentTitle: current?.role ?? '',
    noticePeriod: profile.noticePeriod,
    currentCtc: profile.currentCtc,
    expectedCtc: profile.expectedCtc,
    workMode: profile.workMode ?? '',
    relocate: profile.willingToRelocate,
    workAuthorization: profile.workAuthorization,
    visaSponsorship: profile.visaSponsorship ?? '',
    boundByAgreements: profile.boundByAgreements ?? '',
    eeo: {
      gender: profile.gender ?? '',
      sexualOrientation: profile.sexualOrientation ?? '',
      ethnicity: profile.ethnicity ?? '',
      veteran: profile.veteranStatus ?? '',
      disability: profile.disabilityStatus ?? '',
    },
    experience: profile.experience.slice(0, 10).map((row) => ({
      role: row.role,
      company: row.company,
      startedOn: row.startedOn,
      endedOn: row.endedOn,
      current: row.isCurrent,
      description: (row.description ?? '').slice(0, 1_200),
    })),
    education: profile.education ?? '',
    skills: profile.skills.slice(0, 60),
    resumeText: profile.resumeText ?? '',
    savedAnswers,
  }
}

/**
 * The user's own replies to earlier application questions. Only answers the
 * user gave (not model-resolved ones), latest per question, so a fact stated
 * once ("For India no, for USA yes") informs every later form.
 */
export async function loadSavedAnswers(userId: string, limit = 120): Promise<CandidateDossier['savedAnswers']> {
  const rows = await db
    .select({ label: pendingApplicationQuestions.label, answer: pendingApplicationQuestions.answer, options: pendingApplicationQuestions.options, answerMeta: pendingApplicationQuestions.answerMeta, sensitive: pendingApplicationQuestions.sensitive })
    .from(pendingApplicationQuestions)
    .where(and(eq(pendingApplicationQuestions.userId, userId), inArray(pendingApplicationQuestions.status, ['answered', 'applied'])))
    .orderBy(desc(pendingApplicationQuestions.updatedAt))
    .limit(600)
  const seen = new Set<string>()
  const out: CandidateDossier['savedAnswers'] = []
  for (const row of rows) {
    if (!row.answer || (row.answerMeta as { source?: string } | null)?.source === 'profile_ai') continue
    const key = row.label.replace(/\s+/g, ' ').trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ question: row.label.slice(0, 300), answer: row.answer.slice(0, 1_000), options: (row.options ?? []).slice(0, 30) })
    if (out.length >= limit) break
  }
  return out
}

export function jobContext(job: { title: string; company: string; location: string | null; countries: string[]; remote: boolean; description: string | null }): JobContext {
  return {
    title: job.title,
    company: job.company,
    location: job.location ?? '',
    countries: [...new Set(job.countries.filter(Boolean).map((code) => code.toUpperCase()))],
    remote: job.remote,
    description: (job.description ?? '').slice(0, 8_000),
  }
}
