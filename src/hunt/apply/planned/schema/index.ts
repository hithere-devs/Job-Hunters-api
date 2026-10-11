import { logger } from '../../../../lib/logger.js'
import { loadAshbySchema } from './ashby.js'
import { loadGreenhouseSchema } from './greenhouse.js'
import type { FormSchema } from './types.js'

export type { FormSchema, SchemaField, FieldKind, FieldOption, SchemaSource } from './types.js'
export { ashbyApplicationUrl, ashbyRefFromUrl } from './ashby.js'

/**
 * The published schema for this application URL, or null when the ATS does
 * not publish one (the driver then reads the rendered form). An outage is not
 * a failure: it falls back to the DOM rather than parking the application.
 */
export async function loadPublishedSchema(urls: Array<string | null | undefined>, fetchImpl: typeof fetch = fetch): Promise<FormSchema | null> {
  for (const url of [...new Set(urls.filter((value): value is string => Boolean(value)))]) {
    try {
      const schema = await loadGreenhouseSchema(url, fetchImpl) ?? await loadAshbySchema(url, fetchImpl)
      if (schema) return schema
    } catch (error) {
      logger.warn({ err: error, host: safeHost(url) }, 'published form schema unavailable; falling back to the rendered form')
    }
  }
  return null
}

function safeHost(url: string): string {
  try { return new URL(url).hostname } catch { return 'invalid' }
}
