import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext } from 'playwright-core'
import { env } from '../config/env.js'
import { serviceUnavailable } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { applyExtensionChromeArgs, applyExtensionDir } from './apply/extension-path.js'

/**
 * Browser launch.
 *
 * `playwright-core` ships no browser of its own, so something has to say where
 * Chromium is. This used to default to `/Applications/Google Chrome.app` —
 * correct on one Mac and wrong everywhere else, including in a container.
 *
 * In the runner image `CHROMIUM_EXECUTABLE_PATH` is set explicitly and the
 * driver and browser versions are pinned together. Locally, the macOS Chrome
 * path is still accepted as a fallback so a laptop keeps working, but it is a
 * fallback that announces itself rather than a silent default.
 */

const MACOS_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * Flags that make Chromium survive a container. `--no-sandbox` is required
 * because the process runs unprivileged with no user namespaces; `--dev-shm-usage`
 * because the default 64 MB /dev/shm makes Chromium crash on heavy pages.
 */
const CONTAINER_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']

let warnedAboutFallback = false

/**
 * Where Chromium is, or `undefined` to let Playwright resolve it.
 *
 * Undefined is the right answer inside the runner image: the base image
 * installs a matching Chromium under `PLAYWRIGHT_BROWSERS_PATH` and
 * playwright-core finds it. Hardcoding that path would pin a build number that
 * changes with every Playwright bump, and fail with an unhelpful protocol
 * error when it drifts.
 */
export function automationExecutablePath(options: { requireAutomation?: boolean } = {}): string | undefined {
  if (options.requireAutomation !== false && !env.PORTAL_AUTOMATION_ENABLED) {
    throw serviceUnavailable('Portal automation is disabled. Set PORTAL_AUTOMATION_ENABLED=true.')
  }
  if (env.CHROMIUM_EXECUTABLE_PATH) return env.CHROMIUM_EXECUTABLE_PATH
  if (env.BROWSER_IN_CONTAINER) return undefined

  if (process.platform === 'darwin') {
    if (!warnedAboutFallback) {
      warnedAboutFallback = true
      logger.warn(
        { path: MACOS_CHROME },
        'CHROMIUM_EXECUTABLE_PATH is not set — falling back to the local Chrome install. Set it explicitly outside development.',
      )
    }
    return MACOS_CHROME
  }

  throw serviceUnavailable(
    'CHROMIUM_EXECUTABLE_PATH is required for portal automation outside the runner image.',
  )
}

function launchArgs(): string[] {
  // A local Chrome on a developer's Mac neither needs nor wants the container
  // flags — --no-sandbox in particular is a real weakening, and there is no
  // reason to pay for it outside the container it exists for.
  return env.BROWSER_IN_CONTAINER ? CONTAINER_ARGS : []
}

/**
 * A browser the agent tier can also drive.
 *
 * Stagehand attaches over CDP rather than sharing Playwright's connection, so
 * the port has to be opened at launch. Passing one keeps a single browser for
 * both tiers, which is what lets the live view and takeover keep working while
 * an agent is the thing filling the form — a second, Stagehand-owned browser
 * would be invisible to both.
 */
async function launchHeadlessBrowser(options: { cdpPort?: number; requireAutomation: boolean }): Promise<Browser> {
  const executablePath = automationExecutablePath({ requireAutomation: options.requireAutomation })
  const debugArgs = options?.cdpPort
    ? [`--remote-debugging-port=${options.cdpPort}`, '--remote-allow-origins=*']
    : []
  return chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: [...launchArgs(), ...debugArgs],
  })
}

export function launchAutomationBrowser(options?: { cdpPort?: number }): Promise<Browser> {
  return launchHeadlessBrowser({ ...options, requireAutomation: true })
}

/** Renders local artifacts with the bundled browser without requiring portal automation. */
export function launchHeadlessArtifactBrowser(): Promise<Browser> {
  return launchHeadlessBrowser({ requireAutomation: false })
}

/** An ephemeral free port, so two concurrent applies never collide on CDP. */
export async function freePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

/**
 * A context the user is expected to interact with — signing in to LinkedIn,
 * clearing a challenge.
 *
 * `headless` is now configurable rather than hardcoded to `false`. A visible
 * window is right on a laptop and impossible on a server, and this was the
 * single hardest blocker to deploying the product: the LinkedIn connect flow
 * literally required a monitor attached to the machine running the API.
 *
 * Headless is the default. Until the live-view work lands, connecting an
 * account in a deployed environment needs `AUTOMATION_HEADFUL=true` on a host
 * with a display; locally that is what you already have.
 */
export async function launchInteractiveAutomationContext(
  userDataDir: string,
): Promise<BrowserContext> {
  const executablePath = automationExecutablePath()
  return chromium.launchPersistentContext(userDataDir, {
    ...(executablePath ? { executablePath } : {}),
    headless: !env.AUTOMATION_HEADFUL,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', ...launchArgs()],
  })
}

/**
 * Chrome 152 branded builds ignore `--load-extension`. CDP `Extensions.loadUnpacked`
 * is the remaining path on branded Chrome. Needs `--enable-unsafe-extension-debugging`.
 * Local tests use Playwright Chromium (Chrome for Testing), where `--load-extension` still works.
 */
export async function installHuntlyApplyExtension(context: BrowserContext, browser?: Browser | null): Promise<string | null> {
  const dir = applyExtensionDir()
  const tryLoad = async (cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>>) => {
    const existing = await cdp.send('Extensions.getExtensions').catch(() => ({ extensions: [] as Array<{ id: string; name?: string }> }))
    const already = existing.extensions?.find((item) => /apply pilot|huntly apply/i.test(item.name ?? ''))
    if (already?.id) return already.id
    const result = await cdp.send('Extensions.loadUnpacked', { path: dir })
    return result.id ?? null
  }
  if (browser) {
    const cdp = await browser.newBrowserCDPSession()
    try {
      const id = await tryLoad(cdp)
      if (id) {
        logger.info({ extensionId: id }, 'loaded Huntly apply extension')
        return id
      }
    } catch (error) {
      logger.debug({ err: error }, 'browser CDP extension install unavailable')
    } finally {
      await cdp.detach().catch(() => undefined)
    }
  }
  const page = context.pages()[0] ?? await context.newPage()
  const cdp = await context.newCDPSession(page)
  try {
    const id = await tryLoad(cdp)
    if (id) {
      logger.info({ extensionId: id }, 'loaded Huntly apply extension')
      return id
    }
    return null
  } catch (error) {
    logger.debug({ err: error }, 'CDP extension install unavailable; relying on --load-extension')
    return null
  } finally {
    await cdp.detach().catch(() => undefined)
  }
}

/**
 * Local Chromium with the unpacked Huntly apply extension.
 *
 * Uses Playwright's Chrome for Testing, not branded Google Chrome. Chrome 152
 * dropped `--load-extension` in the branded build.
 */
export async function launchApplyExtensionContext(options?: {
  headed?: boolean
  viewport?: { width: number; height: number }
}): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'huntly-apply-ext-'))
  const headed = options?.headed ?? env.AUTOMATION_HEADFUL
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromium.executablePath(),
    headless: false,
    viewport: options?.viewport ?? { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      ...launchArgs(),
      '--enable-unsafe-extension-debugging',
      ...applyExtensionChromeArgs(),
      ...(headed ? [] : ['--headless=new']),
    ],
  })
  await installHuntlyApplyExtension(context)
  return {
    context,
    async close() {
      await context.close().catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}
