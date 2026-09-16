import { env, hasModelAccess } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { toolCompletion } from '../model/tool-client.js'
import type { Provider } from './providers.js'

/**
 * Reading the screen to decide whether somebody is signed in.
 *
 * The fallback, never the first answer. A cookie-name check is deterministic,
 * instant and free; this costs a model call and can be wrong. It exists for the
 * case the cookie check cannot cover — a platform whose session cookie we have
 * not learned yet, which is every platform on the day it is added.
 *
 * Deliberately asymmetric: this can only *rescue* a verification the cookie
 * check failed. It is never consulted when cookies already prove a session,
 * because a model looking at a screenshot is a weaker signal than a session
 * cookie, and letting the weaker signal overrule the stronger one would be a
 * way to talk the system into recording a sign-in that never happened.
 */

export interface ScreenVerdict {
  signedIn: boolean
  /** What the model saw, for the activity log and for debugging a wrong call. */
  reason: string
}

export async function verifyFromScreen(params: {
  png: Buffer
  provider: Provider
}): Promise<ScreenVerdict | null> {
  if (!hasModelAccess) {
    logger.debug({ provider: params.provider.id }, 'no model configured; skipping the screen check')
    return null
  }

  try {
    const result = await toolCompletion({
      userId: null,
      purpose: 'classify-email',
      maxTokens: Math.min(env.APPLY_AGENT_MAX_TOKENS, 2000),
      messages: [
        {
          role: 'system',
          content: [
            'You decide whether a browser screenshot shows a signed-in account.',
            'Answer with JSON only: {"signedIn": boolean, "reason": string}.',
            'Signed in means the page shows a logged-in state — an account avatar, a',
            'dashboard, a profile menu, a feed personalised to a user.',
            'A login form, a "Sign in" or "Continue with Google" button, a consent',
            'screen, or a two-factor prompt all mean NOT signed in: the sign-in is',
            'still in progress.',
            'If you cannot tell, answer false. A wrong "true" records a connection',
            'that does not exist and the failure surfaces much later, somewhere else.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Is this browser signed in to ${params.provider.label} (${params.provider.domain})?`,
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${params.png.toString('base64')}` },
            },
          ],
        },
      ],
    })

    const raw = result.content?.trim() ?? ''
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) {
      logger.warn({ provider: params.provider.id, raw: raw.slice(0, 200) }, 'screen check returned no JSON')
      return null
    }
    const parsed = JSON.parse(match[0]) as { signedIn?: unknown; reason?: unknown }
    return {
      signedIn: parsed.signedIn === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : '',
    }
  } catch (error) {
    // A failed screen check must not fail the verification request. The cookie
    // result already stands; this could only ever have improved it.
    logger.warn({ err: error, provider: params.provider.id }, 'could not read the screen')
    return null
  }
}
