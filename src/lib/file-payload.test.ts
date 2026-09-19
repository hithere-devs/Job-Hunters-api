import assert from 'node:assert/strict'
import { mkdtemp,rm,writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { browserFilePayload } from './file-payload.js'
import { attachResume } from '../hunt/apply/fill.js'
import type { Page } from 'playwright-core'

it('uploads private prepared resume bytes without exposing runner filesystem paths',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'upload-test-'))
 try {
  const file=path.join(dir,'resume.pdf');await writeFile(file,'%PDF-1.4 fixture',{mode:0o600})
  const payload=await browserFilePayload(file)
  assert.equal(payload.name,'resume.pdf');assert.equal(payload.mimeType,'application/pdf');assert.equal(payload.buffer.toString(),'%PDF-1.4 fixture')
  let received:unknown
  let attachClicked=0
  const input={getAttribute:async()=>'',setInputFiles:async(value:unknown)=>{received=value}}
  const page={locator:()=>({count:async()=>1,nth:()=>input}),getByRole:()=>{attachClicked++;return {count:async()=>0,first(){return this}}}} as unknown as Page
  assert.equal(await attachResume(page,file),true)
  assert.equal(typeof received,'object')
  assert.equal(attachClicked,0)
  input.setInputFiles=async()=>{throw new Error('fixture upload failure')}
  assert.equal(await attachResume(page,file),false)
 } finally {await rm(dir,{recursive:true,force:true})}
})
it('rejects unsupported prepared files',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'upload-test-'))
 try {const file=path.join(dir,'payload.exe');await writeFile(file,'fixture');await assert.rejects(browserFilePayload(file),/Unsupported/)} finally{await rm(dir,{recursive:true,force:true})}
})
