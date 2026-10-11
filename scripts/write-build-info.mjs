import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

// Identity of this build, recorded on every application attempt and in runner
// heartbeats. RUNNER_VERSION overrides it at deploy time.
let sha = 'unknown'
let dirty = false
try {
  sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim()
  dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0
} catch { /* not a git checkout */ }
mkdirSync('dist', { recursive: true })
const version = `${sha}${dirty ? '-dirty' : ''}`
writeFileSync('dist/build-info.json', `${JSON.stringify({ version, builtAt: new Date().toISOString() }, null, 2)}\n`)
console.log(`build-info: ${version}`)
