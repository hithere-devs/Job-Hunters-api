import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function applyExtensionDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    '/opt/huntly/apply-extension',
    path.resolve(here, '../../../apply-extension'),
    path.resolve(here, '../../apply-extension'),
  ]
  const found = candidates.find((candidate) => existsSync(path.join(candidate, 'manifest.json')) && existsSync(path.join(candidate, 'page.js')))
  if (!found) throw new Error(`Huntly apply extension missing. Looked in ${candidates.join(', ')}`)
  return found
}

export function applyExtensionPageScript(): string {
  return path.join(applyExtensionDir(), 'page.js')
}

export function applyExtensionFixturesDir(): string {
  return path.join(applyExtensionDir(), 'fixtures')
}

export function applyExtensionChromeArgs(): string[] {
  const dir = applyExtensionDir()
  return [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`]
}
