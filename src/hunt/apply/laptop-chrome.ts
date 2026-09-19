import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { applyExtensionDir } from './extension-path.js'

const MACOS_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export function huntlyChromeProfileDir(): string {
  return process.env.HUNTLY_CHROME_PROFILE || path.join(os.homedir(), '.huntly', 'chrome-apply')
}

export function brandedChromePath(): string {
  return process.env.CHROMIUM_EXECUTABLE_PATH || MACOS_CHROME
}

async function freePort(): Promise<number> {
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

async function waitForCdp(port: number, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = 'not started'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
      last = `HTTP ${response.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Chrome CDP not up on 127.0.0.1:${port}: ${last}`)
}

async function readPortFile(profileDir: string): Promise<number | null> {
  try {
    const raw = (await readFile(path.join(profileDir, 'huntly-cdp-port'), 'utf8')).trim()
    const port = Number(raw)
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

function sendPipeCommand(incoming: Writable, outgoing: Readable, method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const id = Date.now()
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`pipe CDP timeout waiting for ${method}`))
    }, timeoutMs)
    function onData(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk])
      let idx = buffer.indexOf(0)
      while (idx >= 0) {
        const raw = buffer.subarray(0, idx).toString('utf8').trim()
        buffer = buffer.subarray(idx + 1)
        if (raw) {
          try {
            const message = JSON.parse(raw) as { id?: number; error?: { message?: string }; result?: Record<string, unknown> }
            if (message.id === id) {
              cleanup()
              if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)))
              else resolve(message.result ?? {})
              return
            }
          } catch {
            // Chrome may emit non-JSON on the pipe during startup.
          }
        }
        idx = buffer.indexOf(0)
      }
    }
    function onError(error: Error) {
      cleanup()
      reject(error)
    }
    function cleanup() {
      clearTimeout(timer)
      outgoing.off('data', onData)
      outgoing.off('error', onError)
    }
    outgoing.on('data', onData)
    outgoing.on('error', onError)
    incoming.write(`${JSON.stringify({ id, method, params })}\0`)
  })
}

async function loadUnpackedOverPipe(child: ChildProcess): Promise<string> {
  const incoming = child.stdio[3]
  const outgoing = child.stdio[4]
  if (!incoming || !outgoing || !('write' in incoming) || !('on' in outgoing)) {
    throw new Error('Chrome pipe FDs 3/4 missing')
  }
  const result = await sendPipeCommand(
    incoming as Writable,
    outgoing as Readable,
    'Extensions.loadUnpacked',
    { path: applyExtensionDir() },
  )
  const id = typeof result.id === 'string' ? result.id : ''
  if (!id) throw new Error(`Extensions.loadUnpacked returned ${JSON.stringify(result)}`)
  return id
}

async function loadUnpackedOverBrowserSession(browser: Browser): Promise<string | null> {
  const cdp = await browser.newBrowserCDPSession()
  try {
    const existing = await cdp.send('Extensions.getExtensions').catch(() => ({ extensions: [] as Array<{ id: string; name?: string }> }))
    const already = existing.extensions?.find((item) => /huntly apply/i.test(item.name ?? ''))
    if (already?.id) return already.id
    const result = await cdp.send('Extensions.loadUnpacked', { path: applyExtensionDir() })
    return result.id ?? null
  } catch {
    return null
  } finally {
    await cdp.detach().catch(() => undefined)
  }
}

export interface LaptopChromeSession {
  browser: Browser
  context: BrowserContext
  page: Page
  extensionId: string
  profileDir: string
  port: number
  /** Drops Playwright. Leaves the Chrome window running. */
  disconnect(): Promise<void>
  /** Closes this Chrome profile window. */
  close(): Promise<void>
}

/**
 * Laptop Google Chrome with Huntly Apply loaded unpacked.
 *
 * Chrome 152 ignores `--load-extension`. The Extensions CDP domain is only
 * exposed on `--remote-debugging-pipe` plus `--enable-unsafe-extension-debugging`.
 * Daily Chrome profile is not touched.
 */
export async function launchLaptopChromeWithExtension(): Promise<LaptopChromeSession> {
  const executablePath = brandedChromePath()
  if (!existsSync(executablePath)) {
    throw new Error(`Google Chrome missing at ${executablePath}`)
  }
  const profileDir = huntlyChromeProfileDir()
  await mkdir(profileDir, { recursive: true })

  let port = await readPortFile(profileDir)
  let child: ChildProcess | null = null
  if (port) {
    const alive = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.ok).catch(() => false)
    if (!alive) port = null
  }
  if (!port) {
    port = await freePort()
    child = spawn(executablePath, [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      'about:blank',
    ], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    })
    child.unref()
    await writeFile(path.join(profileDir, 'huntly-cdp-port'), String(port))
    await waitForCdp(port)
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const context = browser.contexts()[0] ?? await browser.newContext()
  const page = context.pages()[0] ?? await context.newPage()
  let extensionId = await loadUnpackedOverBrowserSession(browser)
  if (!extensionId && child) {
    try {
      extensionId = await loadUnpackedOverPipe(child)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`pipe loadUnpacked failed: ${detail}`)
    }
  }
  if (!extensionId) {
    await browser.close().catch(() => undefined)
    throw new Error('Unpacked Huntly Apply failed on branded Chrome: Extensions.loadUnpacked unavailable')
  }

  return {
    browser,
    context,
    page,
    extensionId,
    profileDir,
    port,
    async disconnect() {
      // browser.close() would kill Chrome.
    },
    async close() {
      await browser.close().catch(() => undefined)
    },
  }
}
