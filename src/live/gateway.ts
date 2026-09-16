import type { Server } from 'node:http'
import WebSocket, { WebSocketServer, type WebSocket as WebSocketLike } from 'ws'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { applyAttempts, attemptEvents, huntCandidates, playgroundRuns, userBrowserSessions, users } from '../db/schema.js'
import { getTenantStatus } from '../browser/vm-client.js'
import { env } from '../config/env.js'
import { applicationJobInfo } from '../hunt/application-queue.js'
import { proxyReadOnlyVnc, type VncWatchTarget } from './vnc-watch.js'
import { forwardAttemptInput } from './watch-policy.js'
import { logger } from '../lib/logger.js'
import { verifyAccessToken, type AccessTokenPayload } from '../lib/jwt.js'
import { subscribeToAttempts, type AttemptEventPayload } from '../hunt/apply/events.js'
import { markWatching, sendTakeover, stopWatching, type TakeoverEvent } from '../hunt/apply/screencast.js'
import { subscribeToPlayground, type PlaygroundEvent } from '../playground/events.js'

/**
 * The live view socket.
 *
 * Attaches to the existing HTTP server rather than opening a second port, so
 * there is one thing to expose and one origin for the browser to trust.
 *
 * Two rules make this safe to run next to the API. Every socket is
 * authenticated before it is accepted, and a socket only ever receives events
 * for attempts belonging to the user who opened it — a frame from someone
 * else's application must never reach it.
 */

const VNC_PATH = /^\/live\/([0-9a-f-]{36})\/vnc$/i
const PATH = /^\/live\/([0-9a-f-]{36})(\/watch)?$/i
/** Playground runs get their own path so the two id spaces cannot collide. */
const PLAYGROUND_PATH = /^\/live\/playground\/([0-9a-f-]{36})$/i

/** Refreshed while a socket is open so the runner knows to keep streaming. */
const WATCH_REFRESH_MS = 20_000

interface Client {
  socket: WebSocketLike
  userId: string
  attemptId: string
  unsubscribe: () => void
  refresh: NodeJS.Timeout
}

async function currentSocketIdentity(payload: AccessTokenPayload): Promise<boolean> {
  const [user] = await db.select({authVersion:users.authVersion}).from(users).where(eq(users.id,payload.sub)).limit(1)
  return Boolean(user && user.authVersion === payload.authVersion)
}

/** Only the current VM attempt can reveal this user's full desktop. */
async function authorizeVncAttempt(token: string, attemptId: string): Promise<VncWatchTarget | null> {
  const identity = verifyAccessToken(token)
  if (!await currentSocketIdentity(identity)) return null
  const [session] = await db.select().from(userBrowserSessions).where(and(eq(userBrowserSessions.userId, identity.sub), eq(userBrowserSessions.vmId, env.VM_ID))).limit(1)
  if (!session || session.tenantIndex < 1 || session.tenantIndex > 10) return null
  // One tenant profile has one live Chrome. A stale older attempt must never
  // become a window onto a later attempt merely because its user matches.
  const [latest] = await db.select({ attempt: applyAttempts, candidate: huntCandidates }).from(applyAttempts)
    .innerJoin(huntCandidates, and(eq(huntCandidates.id, applyAttempts.candidateId), eq(huntCandidates.userId, identity.sub)))
    .where(and(eq(applyAttempts.userId, identity.sub), eq(applyAttempts.browserSessionId, `vm:${session.tenantIndex}`)))
    .orderBy(desc(applyAttempts.createdAt)).limit(1)
  if (!latest || latest.attempt.completedAt !== null || latest.candidate.status !== 'applying' || latest.attempt.id !== attemptId || latest.attempt.browserSessionId !== `vm:${session.tenantIndex}` || !['pending', 'submitting'].includes(latest.attempt.status)) return null
  const queue = await applicationJobInfo(identity.sub, latest.candidate.id, latest.candidate.runId)
  if (queue.queueState !== 'active' || !queue.lockActive) return null
  const status = await getTenantStatus(session.tenantIndex)
  if (status.mode !== 'apply' || status.vncReadOnly !== true) return null
  return { tenantIndex: session.tenantIndex, sessionId: session.id, attemptId }
}

export function attachLiveGateway(server: Server): WebSocketServer {
  // `noServer` so the upgrade can be rejected before a socket exists — an
  // unauthenticated client should never reach an open WebSocket.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host ?? 'localhost'}`)
    if (request.headers.origin && !env.CORS_ORIGINS.includes(request.headers.origin)) { socket.destroy(); return }
    const vnc = VNC_PATH.exec(url.pathname)
    if (vnc) {
      const token = url.searchParams.get('token') ?? ''
      // Authentication and ownership run before handleUpgrade or opening VNC.
      void proxyReadOnlyVnc({ request, socket, head, wss, authorize: () => authorizeVncAttempt(token, vnc[1]!) }).catch(() => socket.destroy())
      return
    }
    if (url.pathname === '/me/browser-session/stream') {
      const token = url.searchParams.get('token') ?? ''
      const sessionId = url.searchParams.get('sessionId') ?? ''
      let identity: AccessTokenPayload
      try { identity = verifyAccessToken(token) } catch { socket.destroy(); return }
      const userId = identity.sub
      void (async () => {
        if (!await currentSocketIdentity(identity)) { socket.destroy(); return }
        const [session] = await db.select().from(userBrowserSessions).where(and(eq(userBrowserSessions.id, sessionId), eq(userBrowserSessions.userId, userId))).limit(1).catch(() => [])
        if (!session || session.status !== 'connecting') { socket.destroy(); return }
        const mode = await getTenantStatus(session.tenantIndex)
        if (mode.mode !== 'connect') { socket.destroy(); return }
        const upstream = new WebSocket(`ws://127.0.0.1:${6100 + session.tenantIndex}`)
        upstream.once('open', () => {
          wss.handleUpgrade(request, socket, head, (client) => {
            upstream.on('message', (data, isBinary) => { if (client.readyState === client.OPEN) client.send(data, { binary: isBinary }) })
            client.on('message', (data, isBinary) => { if (upstream.readyState === upstream.OPEN) upstream.send(data, { binary: isBinary }) })
            const guard = setInterval(() => {
              void (async () => {
                const valid = await currentSocketIdentity(verifyAccessToken(token));
                const status = await getTenantStatus(session.tenantIndex);
                if(!valid || status.mode !== 'connect') client.close(1008,'Browser is no longer in connect mode');
              })().catch(()=>client.close(1008,'Session expired'));
            },15000);
            guard.unref();
            const close = () => { clearInterval(guard); if (upstream.readyState === upstream.OPEN) upstream.close(); if (client.readyState === client.OPEN) client.close() }
            client.on('close', close); client.on('error', close); upstream.on('close', close); upstream.on('error', close)
          })
        })
        upstream.once('error', () => socket.destroy())
      })().catch(()=>socket.destroy())
      return
    }
    const playground = PLAYGROUND_PATH.exec(url.pathname)
    const match = playground ?? PATH.exec(url.pathname)
    if (!match) {
      socket.destroy()
      return
    }

    const attemptId = match[1]
    // A browser WebSocket cannot set an Authorization header, so the token
    // arrives as a query parameter. It is short-lived and the connection is
    // same-origin.
    const token = url.searchParams.get('token') ?? ''
    let identity: AccessTokenPayload
    try {
      identity = verifyAccessToken(token)
    } catch {
      socket.destroy()
      return
    }

    const userId = identity.sub
    if (playground) {
      void (async () => {
        if (!await currentSocketIdentity(identity)) { socket.destroy(); return }
        // The run must belong to this user. Without this check any
        // authenticated user could watch anyone's application being filled in.
        const [run] = await db
          .select({ id: playgroundRuns.id })
          .from(playgroundRuns)
          .where(and(eq(playgroundRuns.id, attemptId!), eq(playgroundRuns.userId, userId)))
          .limit(1)
          .catch(() => [])

        if (!run) {
          socket.destroy()
          return
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          acceptPlayground(ws, userId, attemptId!)
        })
      })().catch(()=>socket.destroy())
      return
    }

    void (async () => {
      if (!await currentSocketIdentity(identity)) { socket.destroy(); return }
      // The attempt must belong to this user. Without this check any
      // authenticated user could watch anyone's application.
      const [attempt] = await db
        .select({ id: applyAttempts.id })
        .from(applyAttempts)
        .where(and(eq(applyAttempts.id, attemptId!), eq(applyAttempts.userId, userId)))
        .limit(1)
        .catch(() => [])

      if (!attempt) {
        socket.destroy()
        return
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        accept(ws, userId, attemptId!, Boolean(match[2]), token)
      })
    })().catch(()=>socket.destroy())
  })

  function accept(socket: WebSocketLike, userId: string, attemptId: string, readOnly: boolean, token: string): void {
    void markWatching(attemptId)

    const unsubscribe = subscribeToAttempts(userId, (payload: AttemptEventPayload) => {
      // One socket watches one attempt; everything else on this user's channel
      // belongs to a different tab.
      if (payload.attemptId !== attemptId) return
      if (socket.readyState !== socket.OPEN) return
      socket.send(JSON.stringify(payload), () => undefined)
    })

    const refresh = setInterval(() => {
      void (async () => {
        if (!await currentSocketIdentity(verifyAccessToken(token))) { socket.close(1008,'Session expired'); return }
        await markWatching(attemptId)
      })().catch(()=>socket.close(1008,'Session expired'))
    }, WATCH_REFRESH_MS)
    refresh.unref()

    const client: Client = { socket, userId, attemptId, unsubscribe, refresh }

    socket.on('message', (raw) => {
      forwardAttemptInput(readOnly, String(raw), event => { void sendTakeover(attemptId, event) })
    })

    socket.on('close', () => close(client))
    socket.on('error', () => close(client))

    socket.send(
      JSON.stringify({ type: 'ready', attemptId, readOnly, takeoverWindowMs: readOnly ? 0 : env.APPLY_TAKEOVER_WINDOW_MS }),
      () => undefined,
    )
    // Late watchers receive the last known state, not a misleading Connecting label.
    void db.select().from(attemptEvents).where(eq(attemptEvents.attemptId, attemptId)).orderBy(desc(attemptEvents.at)).limit(1).then(([event]) => {
      if (event && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'state', attemptId, state: event.state, reason: event.reason, detail: null, at: event.at.toISOString() }))
    }).catch(() => undefined)
  }

  /**
   * A playground socket.
   *
   * Read-only, unlike the apply one. There is no takeover channel to forward
   * clicks over because the hosted browser publishes its own live URL and the
   * user clicks in the real thing — anything typed instead goes over HTTP,
   * where it can be validated and recorded.
   */
  function acceptPlayground(socket: WebSocketLike, userId: string, runId: string): void {
    const unsubscribe = subscribeToPlayground(userId, (payload: PlaygroundEvent) => {
      // One socket watches one run; everything else on this user's channel
      // belongs to a different tab.
      if (payload.runId !== runId) return
      if (socket.readyState !== socket.OPEN) return
      socket.send(JSON.stringify(payload), () => undefined)
    })

    socket.on('close', unsubscribe)
    socket.on('error', unsubscribe)
    socket.send(JSON.stringify({ type: 'ready', runId }), () => undefined)
  }

  function close(client: Client): void {
    clearInterval(client.refresh)
    client.unsubscribe()
    void stopWatching(client.attemptId)
  }

  logger.info('live view gateway attached')
  return wss
}
