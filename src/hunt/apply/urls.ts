import { isPlausibleWebsiteUrl } from '../../lib/website-url.js'

export { isPlausibleWebsiteUrl }

/**
 * Application forms expect a plain absolute URL. Models and copied profile
 * data sometimes supply a Markdown link instead, or omit the scheme; accepting
 * those small variations here keeps a malformed value from breaking a run.
 */
export function normaliseHttpUrl(value: string): string {
  const raw = value.trim()
  if (!raw) return ''

  // Accept `[label](https://example.com)` as a convenience, but never pass
  // Markdown itself into a browser form or page navigation.
  const markdown = /^\[[^\]]*\]\((https?:\/\/[^)\s]+)\)$/i.exec(raw)
  const candidate = (markdown?.[1] ?? raw).replace(/^<|>$/g, '')
  if (!isPlausibleWebsiteUrl(candidate)) return ''
  const absolute = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`

  try {
    const parsed = new URL(absolute)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.toString().replace(/\/$/, parsed.pathname === '/' ? '/' : '')
  } catch {
    return ''
  }
}
