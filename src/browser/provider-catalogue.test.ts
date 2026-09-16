import assert from 'node:assert/strict'
import { it } from 'node:test'
import { providerCatalogue } from './provider-catalogue.js'
it('distinguishes anonymous discovery from supported account connections', () => {
  const catalogue = providerCatalogue()
  const greenhouse = catalogue.find((p) => p.id === 'greenhouse')!
  assert.equal(greenhouse.requiresAccount, false)
  assert.equal(greenhouse.supportsApplying, true)
  const wellfound = catalogue.find((p) => p.id === 'wellfound')!
  assert.equal(wellfound.supportsScraping, false)
  assert.equal(wellfound.requiresAccount, true)
  const yc = catalogue.find((p) => p.id === 'workatastartup')!
  assert.equal(yc.supportsApplying, true)
  assert.equal(yc.available, false)
  assert.match(yc.unavailableReason!, /verification/)
  assert.equal(catalogue.some((p) => String(p.id) === 'linkedin'), false)
})
