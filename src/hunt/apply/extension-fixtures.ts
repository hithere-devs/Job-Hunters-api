import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { applyExtensionFixturesDir } from './extension-path.js'

export async function serveApplyFixtures(): Promise<{ origin: string; close: () => Promise<void> }> {
  const root = applyExtensionFixturesDir()
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const name = url.pathname === '/' ? 'application.html' : path.basename(url.pathname)
    const file = path.join(root, name)
    if (!file.startsWith(root)) {
      response.writeHead(403).end()
      return
    }
    try {
      const body = await readFile(file)
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(body)
    } catch {
      response.writeHead(404).end('missing fixture')
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve())
    server.once('error', reject)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}
