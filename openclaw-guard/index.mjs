import { decide, readPolicy } from './guard.mjs'
import { describeElement, loadRuntime, pageFacts } from './runtime.mjs'

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
        const root = process.env.HUNTLY_OPENCLAW_ROOT || '/opt/huntly/openclaw-runtime/node_modules/openclaw'
        const runtime = await loadRuntime(root)
        const cdpUrl = `http://127.0.0.1:${9200 + tenant}`
        if (context.abortSignal?.aborted) throw new Error('cancelled')
        const page = await runtime.pageForTarget({ cdpUrl, targetId: policy.targetId })
        runtime.restoreRoleRefs({ page, cdpUrl, targetId: policy.targetId })
        const facts = await pageFacts(page, policy.targetId)
        const result = await decide(event, policy, facts, async (ref) => {
          if (!/^(?:f\d+)?(?:e|ax)?\d+$/.test(ref)) throw new Error('invalid_ref')
          const locator = runtime.refLocator(page, ref)
          if (await locator.count() !== 1) throw new Error('ambiguous_ref')
          return locator.evaluate(describeElement, undefined, { timeout: 3000 })
        })
        if (context.abortSignal?.aborted || policy.deadlineEpoch <= Date.now()) throw new Error('expired')
        return result
      } catch {
        return { block: true, blockReason: 'huntly_guard:policy_or_browser_verification_failed' }
      }
    }, { priority: -1000000, timeoutMs: 10000 })
  },
}
