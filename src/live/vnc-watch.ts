import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'

export interface VncWatchTarget { tenantIndex: number; sessionId: string; attemptId: string }
/** RFB needs bidirectional protocol negotiation. Input is disabled at x11vnc,
 * not merely by a browser flag. Never point this at an interactive VNC server. */
export async function proxyReadOnlyVnc(input: {
  request: IncomingMessage; socket: Duplex; head: Buffer; wss: WebSocketServer
  authorize: () => Promise<VncWatchTarget | null>
  guardMs?: number
  upstreamUrl?: (tenantIndex: number) => string
}): Promise<void> {
  const authorize = async () => {
    let timer: NodeJS.Timeout | undefined
    try { return await Promise.race([input.authorize(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 3000) })]) }
    catch { return null }
    finally { clearTimeout(timer) }
  }
  const target = await authorize()
  if (!target || input.socket.destroyed) { input.socket.destroy(); return }
  const address = new URL(input.upstreamUrl?.(target.tenantIndex) ?? `ws://127.0.0.1:${6100 + target.tenantIndex}`)
  if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1') { input.socket.destroy(); return }
  const upstream = new WebSocket(address, { handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 })
  const cancelPending = () => upstream.terminate()
  input.socket.once('close', cancelPending)
  upstream.once('error', () => input.socket.destroy())
  upstream.once('open', () => {
    if (input.socket.destroyed) { upstream.terminate(); return }
    input.wss.handleUpgrade(input.request, input.socket, input.head, (client) => {
      input.socket.off('close', cancelPending)
      let checking = false, closed = false
      const close = () => {
        if (closed) return
        closed = true; clearInterval(guard)
        client.terminate(); upstream.terminate()
      }
      upstream.on('message', (data, isBinary) => {
        if (client.bufferedAmount > 2 * 1024 * 1024) { close(); return }
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
      })
      client.on('message', (data, isBinary) => {
        if (upstream.bufferedAmount > 64 * 1024) { close(); return }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
      })
      const guard = setInterval(() => {
        if (checking || closed) return
        checking = true
        void authorize().then(current => {
          if (!current || current.tenantIndex !== target.tenantIndex || current.sessionId !== target.sessionId || current.attemptId !== target.attemptId) close()
        }, close).finally(() => { checking = false })
      }, input.guardMs ?? 5000)
      guard.unref()
      client.on('close', close); client.on('error', close); upstream.on('close', close); upstream.on('error', close)
    })
  })
}
