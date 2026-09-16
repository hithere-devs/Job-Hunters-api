import { PORTAL_CATALOGUE } from '../db/portal-catalogue.js'
import { allConnectors } from '../hunt/discovery/registry.js'
import { skillById } from '../skills/registry.js'
import { PROVIDERS } from './providers.js'

/** Capability explanations come from shipped connectors/skills, not a list of popular websites. */
export function providerCatalogue() {
  const connectors = new Map(allConnectors().map((connector) => [connector.id, connector]))
  const anonymousAts = new Set(['greenhouse', 'ashby', 'lever', 'smartrecruiters', 'workable'])
  return PORTAL_CATALOGUE.map((portal) => {
    const connector = connectors.get(portal.id)
    const account = PROVIDERS.find((provider) => provider.id === portal.id)
    const skill = skillById(portal.id)
    const requiresAccount = Boolean(account || skill?.manifest.authMode === 'profile')
    const supportsApplying = Boolean(account?.supportsApplying || skill?.manifest.capabilities.apply || anonymousAts.has(portal.id))
    const unavailableReason = requiresAccount && !account ? 'Application adapter exists, but browser-session verification is not validated for this provider yet. Account connection is unavailable.' : connector?.unavailableReason ?? null
    return {
      id: portal.id, label: portal.name, url: portal.websiteUrl,
      supportsScraping: Boolean(connector), supportsApplying, requiresAccount,
      available: unavailableReason === null,
      unavailableReason,
      setup: account?.setup ?? (requiresAccount ? 'A human-created account is required. Do not use Google connection as proof of this provider login.' : anonymousAts.has(portal.id) ? 'No job-board account is required for public employer forms. A posting may still request human verification.' : 'Discovery source only. Apply through the original employer link; connecting an account here is not needed.'),
    }
  })
}
