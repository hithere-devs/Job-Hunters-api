import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
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
let xvfb: ChildProcess | null = null
let display: string | null = null

/**
 * A private X display for a windowed Chrome on a server. Headless Chrome
 * announces itself and draws CAPTCHA challenges that a normal window does not;
 * the tenant browsers have always run windowed on Xvfb. The display lives and
 * dies with this process (the runner's PrivateTmp keeps its socket private).
 */
async function virtualDisplay(): Promise<string | undefined> {
  if (env.EPHEMERAL_BROWSER_HEADLESS) return undefined
  if (process.env.DISPLAY) return process.env.DISPLAY
  if (process.platform === 'darwin') return undefined
  if (display && xvfb && xvfb.exitCode === null) return display
  const number = 90 + (process.pid % 9)
  xvfb = spawn('Xvfb', [`:${number}`, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' })
  xvfb.once('exit', (code) => { logger.warn({ code }, 'virtual display exited'); display = null })
  const deadline = Date.now() + 5_000
  while (!existsSync(`/tmp/.X11-unix/X${number}`) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  display = `:${number}`
  return display
}

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
  const screen = await virtualDisplay()
  shared = chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: env.EPHEMERAL_BROWSER_HEADLESS,
    args: [...ARGS, ...(env.EPHEMERAL_BROWSER_HEADLESS ? [] : ['--window-size=1440,900', '--window-position=0,0'])],
    ...(screen ? { env: { ...process.env, DISPLAY: screen } } : {}),
  })
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
  xvfb?.kill('SIGTERM')
  xvfb = null
}
