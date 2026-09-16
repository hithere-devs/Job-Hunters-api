import assert from 'node:assert/strict'
import { it } from 'node:test'
import { isFlagAdministrator } from './admin-flags.js'
it('admin review is default-deny and only exact UUID allowlist membership grants access',()=>{
 const id='00000000-0000-4000-8000-000000000001'
 assert.equal(isFlagAdministrator(id,undefined),false)
 assert.equal(isFlagAdministrator(id,''),false)
 assert.equal(isFlagAdministrator(id,'*'),false)
 assert.equal(isFlagAdministrator(id,` ${id} `),true)
 assert.equal(isFlagAdministrator('00000000-0000-4000-8000-000000000002',id),false)
})
