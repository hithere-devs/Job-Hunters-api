import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { launchApplyExtensionContext } from '../browser.js'
import { serveApplyFixtures } from './extension-fixtures.js'
import { emptyRequiredFields, ensureHuntlyApply, fillPageField, inventoryFields } from './extension-page.js'

const headed = process.env.APPLY_EXTENSION_HEADED === '1'
const launched = await launchApplyExtensionContext({ headed })

describe('Huntly apply Chrome extension', () => {
  after(async () => { await launched.close() })

  it('injects on a local HTTP application and fills required widgets', async () => {
    const fixtures = await serveApplyFixtures()
    const page = launched.context.pages()[0] ?? await launched.context.newPage()
    try {
      await page.goto(`${fixtures.origin}/application.html`, { waitUntil: 'domcontentloaded' })
      await ensureHuntlyApply(page, { injectIfMissing: false })
      const fields = await inventoryFields(page, 'form')
      const labels = fields.map((field) => field.label)
      assert.ok(labels.some((label) => /full name/i.test(label)), labels.join(' | '))
      assert.ok(labels.some((label) => /learn about this opportunity/i.test(label)), labels.join(' | '))
      assert.ok(labels.some((label) => /location/i.test(label)), labels.join(' | '))
      assert.equal(await fillPageField(page, fields.find((field) => /full name/i.test(field.label))!, 'Ayan Mansoori'), true)
      assert.equal(await fillPageField(page, fields.find((field) => /email/i.test(field.label))!, 'ayan@example.com'), true)
      assert.equal(await fillPageField(page, fields.find((field) => /cover letter/i.test(field.label))!, 'Backend engineer applying for this role.'), true)
      assert.equal(await fillPageField(page, fields.find((field) => /location/i.test(field.label))!, 'Bengaluru', {
        city: 'Bengaluru',
        region: 'Karnataka',
        country: 'India',
      }), true)
      assert.equal(await fillPageField(page, fields.find((field) => /learn about this opportunity/i.test(field.label))!, 'LinkedIn'), true)
      assert.equal(await fillPageField(page, fields.find((field) => /authorized to work/i.test(field.label))!, 'No'), true)
      assert.equal(await fillPageField(page, fields.find((field) => /privacy notice/i.test(field.label))!, 'true'), true)
      assert.equal((await emptyRequiredFields(page)).length, 0)
      assert.equal(await page.locator('#loc').inputValue(), 'Bengaluru, Karnataka, India')
      assert.equal(await page.locator('[data-field-entry-id] input').inputValue(), 'LinkedIn')
    } finally {
      await fixtures.close()
    }
  })
})
