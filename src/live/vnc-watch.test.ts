import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { afterEach, test } from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { proxyReadOnlyVnc, type VncWatchTarget } from './vnc-watch.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function fixture(authorize: () => Promise<VncWatchTarget | null>) {
  let upstreamConnections = 0
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => upstream.once('listening', resolve))
  upstream.on('connection', socket => {
    upstreamConnections++
    socket.send(Buffer.from('RFB 003.008\n'))
    socket.on('message', data => socket.send(data))
  })
  const address = upstream.address(); assert.ok(address && typeof address !== 'string')
  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => { void proxyReadOnlyVnc({ request, socket, head, wss, authorize, guardMs: 20, upstreamUrl: () => `ws://127.0.0.1:${address.port}` }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const api = server.address(); assert.ok(api && typeof api !== 'string')
  cleanup.push(async () => { for (const socket of upstream.clients) socket.terminate(); for (const socket of wss.clients) socket.terminate(); await Promise.all([new Promise<void>(resolve => upstream.close(() => resolve())), new Promise<void>(resolve => wss.close(() => resolve())), new Promise<void>(resolve => server.close(() => resolve()))]) })
  return { url: `ws://127.0.0.1:${api.port}/live/attempt/vnc`, upstreamConnections: () => upstreamConnections }
}
const target: VncWatchTarget = { tenantIndex: 9, sessionId: 'owned-session', attemptId: 'active-attempt' }
test('unauthorized VNC watch never opens an upstream connection or accepted socket', async () => {
  const app = await fixture(async () => null)
  const socket = new WebSocket(app.url)
  let opened = false; socket.on('open', () => { opened = true })
  await new Promise<void>(resolve => socket.on('error', () => resolve()))
  assert.equal(opened, false); assert.equal(app.upstreamConnections(), 0)
})
test('read-only VNC proxy relays binary protocol and closes when ownership/mode authorization expires', async () => {
  let current: VncWatchTarget | null = target
  const app = await fixture(async () => current)
  const socket = new WebSocket(app.url)
  const frames: string[] = []
  socket.on('message', data => frames.push(data.toString()))
  await new Promise<void>(resolve => socket.once('open', resolve))
  const echoed = new Promise<void>(resolve => socket.on('message', data => { if (data.toString() === 'framebuffer-request') resolve() }))
  socket.send(Buffer.from('framebuffer-request'))
  await echoed
  assert.ok(frames.includes('RFB 003.008\n'))
  assert.ok(frames.includes('framebuffer-request'))
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
  current = null
  await closed
  assert.equal(app.upstreamConnections(), 1)
})
test('reassigned session or new attempt severs the old watch', async () => {
  let current = target
  const app = await fixture(async () => current)
  const socket = new WebSocket(app.url)
  await new Promise<void>(resolve => socket.once('open', resolve))
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
  current = { ...target, sessionId: 'replacement-session' }
  await closed
})
