const LANGUAGE_TLDS = new Set([
  'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'php', 'cs', 'kt', 'swift',
])

const SKILL_HOSTS = new Set([
  'next.js', 'node.js', 'vue.js', 'nuxt.js', 'deno.js', 'express.js', 'nest.js', 'fastify.js',
])

/** True for a public website, not a skill token like Next.js. */
export function isPlausibleWebsiteUrl(value: string): boolean {
  const raw = value.trim()
  if (!raw) return false
  const withoutScheme = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0]?.toLowerCase() ?? ''
  if (SKILL_HOSTS.has(withoutScheme)) return false
  try {
    const absolute = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    const parsed = new URL(absolute)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase()
    const tld = host.split('.').pop() ?? ''
    if (LANGUAGE_TLDS.has(tld)) return false
    return host.includes('.')
  } catch {
    return false
  }
}
