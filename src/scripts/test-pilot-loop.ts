import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { serveApplyFixtures } from '../hunt/apply/extension-fixtures.js'
import { applyWithPilot } from '../hunt/apply/pilot-driver.js'
import { emptyRequiredFields, snapshotPage } from '../hunt/apply/pilot-page.js'
import { launchApplyExtensionContext } from '../hunt/browser.js'
import type { PortalProfile } from '../hunt/portal-profile.js'

/**
 * Fixture loop: Apply Pilot + Jev against the local application HTML.
 *
 *   npx tsx src/scripts/test-pilot-loop.ts
 */
const headed = process.env.APPLY_EXTENSION_HEADED === '1'
const fixtures = await serveApplyFixtures()
const launched = await launchApplyExtensionContext({ headed })
const page = launched.context.pages()[0] ?? await launched.context.newPage()
const scratch = await mkdtemp(path.join(os.tmpdir(), 'pilot-resume-'))
const resumePath = path.join(scratch, 'resume.pdf')
await writeFile(resumePath, '%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

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
  noticePeriod: '30 days',
  currentCtc: '',
  expectedCtc: '',
  workAuthorization: 'No',
  willingToRelocate: 'Yes',
  skills: ['typescript', 'node'],
  experience: [{
    role: 'Engineer',
    company: 'Acme',
    startedOn: '2023-01-01',
    endedOn: null,
    isCurrent: true,
    description: 'Built APIs.',
  }],
  photoStoragePath: null,
  photoFileName: null,
  baseResume: { id: 'r1', fileName: 'resume.pdf', storagePath: 'x', mimeType: 'application/pdf' },
  resumeDocument: null,
} satisfies PortalProfile

try {
  const url = `${fixtures.origin}/application.html`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  const result = await applyWithPilot({
    page,
    url,
    userId: '00000000-0000-4000-8000-000000000001',
    attemptId: '00000000-0000-4000-8000-000000000002',
    profile,
    resumePath,
    job: { title: 'Staff Engineer', company: 'Atlan', location: 'Bengaluru' },
  })
  const leftover = await emptyRequiredFields(page)
  const snap = await snapshotPage(page)
  const report = {
    url: page.url(),
    recipe: result.recipe,
    canSubmit: result.canSubmit ?? leftover.length === 0,
    submitted: result.submitted ?? false,
    fields: result.fields,
    unresolved: result.unresolved,
    leftover: leftover.map((field) => field.label),
    values: Object.fromEntries(snap.elements.filter((el) => el.role !== 'button').map((el) => [el.label, el.value])),
  }
  console.log(JSON.stringify(report, null, 2))
  if (leftover.length || (result.unresolved.length && !result.canSubmit)) process.exitCode = 1
} finally {
  if (!headed) await launched.close()
  await fixtures.close()
  process.exit(process.exitCode ?? 0)
}
