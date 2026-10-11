import crypto from 'node:crypto'
import { chromium, type Browser } from 'playwright-core'
import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { automationExecutablePath } from '../hunt/browser.js'
import { applyPilotSource } from '../hunt/apply/pilot-page.js'
import type { Slot } from './limit.js'
import type { AgentSession } from './session.js'

/**
 * Throwaway browsers for forms that need no sign-in.
 *
 * Greenhouse, Ashby, Lever and most career sites are anonymous forms. Running
 * them inside the user's signed-in VM profile forced every application for a
 * user through one Chrome, one at a time, with a cold start and a VNC restart
 * per application. Here one shared Chrome process serves many isolated
 * incognito contexts: nothing crosses between applications, and they run in
 * parallel. The page script is installed as an init script, so it is present
 * in every frame before any page code runs and no extension is needed.
 */

let shared: Promise<Browser> | null = null

const ARGS = [
  '--disable-dev-shm-usage',
  '--disable-features=TranslateUI',
  '--no-first-run',
  '--no-default-browser-check',
  ...(env.BROWSER_IN_CONTAINER ? ['--no-sandbox'] : []),
]

async function sharedBrowser(): Promise<Browser> {
  if (shared) {
    const existing = await shared.catch(() => null)
    if (existing?.isConnected()) return existing
    shared = null
  }
  const executablePath = automationExecutablePath()
  shared = chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: env.EPHEMERAL_BROWSER_HEADLESS, args: ARGS })
  const browser = await shared.catch((error: unknown) => {
    shared = null
    throw error
  })
  browser.on('disconnected', () => {
    logger.warn('shared ephemeral browser disconnected; the next application relaunches it')
    shared = null
  })
  return browser
}

export async function openEphemeral(options: { userId: string | null; label: string; viewport?: { width: number; height: number } }, slot: Slot): Promise<AgentSession> {
  const browser = await sharedBrowser()
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1366, height: 900 },
    locale: 'en-US',
    acceptDownloads: false,
  })
  await context.addInitScript({ content: applyPilotSource() })
  const page = await context.newPage()
  let closed = false
  return {
    browser,
    context,
    page,
    provider: 'ephemeral',
    liveUrl: null,
    sessionId: `ephemeral:${crypto.randomUUID()}`,
    async close() {
      if (closed) return
      closed = true
      try {
        await context.close().catch(() => undefined)
      } finally {
        slot.release()
      }
    },
  }
}

/** For shutdown. Contexts still open are closed with the browser. */
export async function closeEphemeralBrowser(): Promise<void> {
  const current = shared
  shared = null
  if (!current) return
  const browser = await current.catch(() => null)
  await browser?.close().catch(() => undefined)
}
