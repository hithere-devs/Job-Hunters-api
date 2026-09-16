/** Run on the VM as root. Tenant 9 only; does not launch or inspect Chrome. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'

if (process.getuid() !== 0) throw new Error('Run this fixture on the VM as root.')
const source = await readFile('/opt/huntly/vm-agent/server.ts', 'utf8')
assert.ok(source.includes('destination is tenant-controlled'), 'Deploy the tenant-owned upload fix first.')
const env = await readFile('/etc/huntly/vm-agent.env', 'utf8')
const token = env.split('\n').find(line => line.startsWith('VM_AGENT_TOKEN='))?.slice('VM_AGENT_TOKEN='.length).replace(/^"|"$/g, '')
assert.ok(token, 'VM agent authentication configuration missing')
const headers = { Authorization: `Bearer ${token}` }
const status = await fetch('http://127.0.0.1:18900/tenants/9/status', { headers, signal: AbortSignal.timeout(5000) })
assert.equal(status.status, 200)
assert.equal((await status.json()).mode, 'idle', 'Tenant 9 is busy; fixture must not modify an active session.')
const uid = Number(execFileSync('id', ['-u', 'huntly-u9'], { encoding: 'utf8' }).trim())
const gid = Number(execFileSync('id', ['-g', 'huntly-u9'], { encoding: 'utf8' }).trim())
for (const directory of ['/home', '/home/huntly-u9', '/home/huntly-u9/run']) {
  const stat = await lstat(directory)
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Fixture requires normal tenant directories.')
}
const id = randomUUID()
const destination = '/home/huntly-u9/run/huntly-resume.pdf'
const backup = `${destination}.fixture-backup-${id}`
const sentinel = `/var/tmp/huntly-root-sentinel-${id}`
const originalSentinel = Buffer.from(`root-owned safety sentinel ${id}\n`)
const fixtureResume = Buffer.from('%PDF-1.4\n% Synthetic resume security fixture only\n%%EOF\n')
let originalSaved = false
let installedFixture = false
try {
  await writeFile(sentinel, originalSentinel, { flag: 'wx', mode: 0o600 })
  try {
    const original = await lstat(destination)
    assert.ok(original.isFile() || original.isSymbolicLink(), 'Existing resume is not a file or symlink; refusing fixture.')
    await rename(destination, backup)
    originalSaved = true
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  execFileSync('sudo', ['-u', 'huntly-u9', 'ln', '-s', sentinel, destination])
  installedFixture = true
  const response = await fetch('http://127.0.0.1:18900/tenants/9/resume', {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/pdf' }, body: fixtureResume, signal: AbortSignal.timeout(35000),
  })
  const body = await response.json()
  console.log(`PUT /tenants/9/resume HTTP ${response.status} ${JSON.stringify(body)}`)
  assert.equal(response.status, 200)
  assert.deepEqual(await readFile(sentinel), originalSentinel, 'Root sentinel contents must remain unchanged.')
  const sentinelStat = await lstat(sentinel)
  assert.equal(sentinelStat.uid, 0, 'Root sentinel owner must remain root.')
  assert.equal(sentinelStat.mode & 0o777, 0o600)
  console.log('PASS root-owned sentinel unchanged; owner=0 mode=0600')
  const result = await lstat(destination)
  assert.ok(result.isFile() && !result.isSymbolicLink(), 'Upload must replace the symlink with a regular file.')
  assert.equal(result.uid, uid)
  assert.equal(result.gid, gid)
  assert.equal(result.mode & 0o777, 0o600)
  assert.deepEqual(await readFile(destination), fixtureResume)
  console.log('PASS destination is a regular file; owner=huntly-u9 group=huntly-u9 mode=0600; upload bytes match')
} finally {
  if (installedFixture) await rm(destination, { force: true })
  if (originalSaved) await rename(backup, destination)
  await rm(sentinel, { force: true })
  console.log(`CLEANUP ${originalSaved ? 'original tenant 9 resume restored' : 'fixture resume removed; no original resume existed'}; sentinel removed`)
}
