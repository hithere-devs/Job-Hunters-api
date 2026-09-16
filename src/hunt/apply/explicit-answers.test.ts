import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runWithDatabase, type DatabaseTransaction } from '../../db/client.js'
import { canReuseExplicitAnswer, credentialFieldReason, resolveField, validExplicitAnswer, valueFromProfile, type FormField } from './fields.js'
import type { PortalProfile } from '../portal-profile.js'

const profile = { fullName: 'Test Person', email: '', phone: '', headline: '', links: { linkedin: '', github: '', portfolio: '' }, address: { line1: '', city: '', region: '', postalCode: '', country: '' }, experience: [{ company: 'Previous Employer', isCurrent: false, endedOn: '2025-01-01' }], totalExperience: '5' } as unknown as PortalProfile
const context = { userId: 'owner', host: 'jobs.example.test', profile }
const field: FormField = { label: 'Gender', type: 'select', required: true, options: ['Female', 'Male', 'Prefer not to say'] }
function cached(rows: unknown[]): DatabaseTransaction {
  return { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) }), update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }) } as unknown as DatabaseTransaction
}

describe('explicit answer provenance', () => {
  it('reuses only this user confirmed explicit answer for a matching sensitive option', async () => {
    const result = await runWithDatabase(cached([{ id: 'answer', userId: 'owner', confirmed: true, provenance: 'explicit_user', value: 'Prefer not to say' }]), () => resolveField(field, context))
    assert.equal(result.value, 'Prefer not to say')
  })
  it('does not trust legacy, generated, unconfirmed, shared or another user answers', async () => {
    for (const row of [
      { userId: 'owner', provenance: 'legacy', confirmed: true },
      { userId: 'owner', provenance: 'generated_from_profile', confirmed: true },
      { userId: 'owner', provenance: 'explicit_user', confirmed: false },
      { userId: null, provenance: 'explicit_user', confirmed: true },
      { userId: 'other', provenance: 'explicit_user', confirmed: true },
    ]) {
      const result = await runWithDatabase(cached([{ ...row, value: 'Female' }]), () => resolveField(field, context))
      assert.equal(result.blocked, 'sensitive_field')
      assert.equal(result.value, null)
    }
  })
  it('does not repurpose a saved answer when options changed', async () => {
    const result = await runWithDatabase(cached([{ userId: 'owner', confirmed: true, provenance: 'explicit_user', value: 'Different option' }]), () => resolveField(field, context))
    assert.equal(result.value, null)
  })
  it('requires per-application legal and contextual motivation answers', () => {
    for (const label of ['Employment agreement', 'Criminal history', 'Reference email', 'Why this company?', 'Cover letter']) assert.equal(canReuseExplicitAnswer({ label, type: 'textarea', required: true }), false)
  })
  it('never routes login codes, passwords, or CAPTCHA through chat or cache', async () => {
    for (const label of ['Password', 'Verification code', 'OTP', 'CAPTCHA', 'Recovery code']) {
      const secret = { label, type: 'text', required: true }
      assert.ok(credentialFieldReason(secret))
      assert.equal(validExplicitAnswer(secret, 'sensitive-value'), null)
      assert.equal((await resolveField(secret, context)).blocked, 'sensitive_field')
    }
  })
  it('returns missing profile facts without asking a model to invent them', async () => {
    const result = await runWithDatabase(cached([]), () => resolveField({ label: 'Email', type: 'email', required: true }, context))
    assert.equal(result.value, null)
    assert.equal(result.blocked, 'unknown_field')
    assert.equal(valueFromProfile('currentCompany', profile), 'Previous Employer')
    assert.equal(valueFromProfile('totalExperience', profile), '5')
  })
})
