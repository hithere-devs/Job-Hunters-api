import { decide, readPolicy, assertRunContext } from './guard.mjs'
import { describeElement, loadRuntime, pageFacts, selectGuardBrowser } from './runtime.mjs'

export default {
  id: 'huntly-application-guard',
  name: 'Huntly application guard',
  register(api) {
    api.on('before_tool_call', async (event, context) => {
      try {
        // No policy content, fields, screenshots, model arguments or secrets in logs.
        if (event.toolName !== 'browser') return { block: true, blockReason: 'huntly_guard:tool_not_browser' }
        const tenant = Number(process.env.HUNTLY_TENANT_INDEX)
        const policy = await readPolicy(process.env.HUNTLY_POLICY_PATH, tenant)
        assertRunContext(policy, context)
        const root = process.env.HUNTLY_OPENCLAW_ROOT || '/opt/huntly/openclaw-runtime/node_modules/openclaw'
        const runtime = await loadRuntime(root)
        if (context.abortSignal?.aborted) throw new Error('cancelled')
        const profileName = process.env.HUNTLY_BROWSER_PROFILE || 'tenant'
        const browser = await selectGuardBrowser({ runtime, policy, tenant, profileName, expectedPort: Number(process.env.HUNTLY_EXTENSION_CDP_PORT), action: event.params?.action })
        const rawFacts = await pageFacts(browser.rawPage, policy.targetId)
        const rawProof = await decide({ toolName: 'browser', params: { action: 'snapshot' } }, policy, rawFacts, async () => { throw new Error('no_bootstrap_refs') }, Date.now(), { profileName })
        if (rawProof.block) return rawProof
        const page = browser.refPage
        if (page) runtime.restoreRoleRefs({ page, cdpUrl: browser.cdpUrl, targetId: policy.targetId })
        const facts = page && page !== browser.rawPage ? await pageFacts(page, policy.targetId) : rawFacts
        const result = await decide(event, policy, facts, async (ref) => {
          if (!page || !/^(?:f\d+)?(?:e|ax)?\d+$/.test(ref)) throw new Error('invalid_or_unavailable_ref')
          const locator = runtime.refLocator(page, ref)
          if (await locator.count() !== 1) throw new Error('ambiguous_ref')
          return locator.evaluate(describeElement, undefined, { timeout: 3000 })
        }, Date.now(), { profileName })
        if (context.abortSignal?.aborted || policy.deadlineEpoch <= Date.now()) throw new Error('expired')
        return result
      } catch {
        return { block: true, blockReason: 'huntly_guard:policy_or_browser_verification_failed' }
      }
    }, { priority: -1000000, timeoutMs: 10000 })
  },
}
