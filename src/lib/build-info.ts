import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../config/env.js'

let cached: string | null = null

/**
 * The build identity of this process: RUNNER_VERSION if set, else the git SHA
 * written by the build into dist/build-info.json, else "dev". Recorded on every
 * attempt and in runner heartbeats so a metric can be tied to the code that
 * produced it, and a mismatched runner can be refused.
 */
export function runnerVersion(): string {
  if (cached) return cached
  if (env.RUNNER_VERSION) return (cached = env.RUNNER_VERSION)
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const candidate of [path.resolve(here, '../build-info.json'), path.resolve(here, '../../dist/build-info.json')]) {
    try {
      const info = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string }
      if (info.version) return (cached = info.version)
    } catch { /* not built */ }
  }
  return (cached = 'dev')
}
