import type { Page } from 'playwright-core'
import { logger } from '../../lib/logger.js'
import { getRedis } from '../../lib/redis.js'
import { hasRedis } from '../../config/env.js'
import { publishAttemptEvent } from './events.js'

/**
 * Streaming what the browser is doing, while it does it.
 *
 * Uses CDP's own screencast rather than a screenshot loop: Chrome pushes a
 * frame when the page actually changes, so an idle form costs nothing and a
 * fast-filling one stays smooth.
 *
 * Two things keep this from being expensive. Frames are only produced while
 * somebody is watching — the runner checks a Redis key the gateway maintains —
 * and they are capped, because a form being filled generates far more frames
 * than a person can perceive.
 */

/** Roughly five frames a second is smooth enough to follow and cheap to send. */
const MIN_FRAME_GAP_MS = 200

function watcherKey(attemptId: string): string {
  return `huntly:watching:${attemptId}`
}

/** The gateway sets this while a browser has the live view open. */
export async function markWatching(attemptId: string, ttlSeconds = 60): Promise<void> {
  if (!hasRedis) return
  await getRedis().set(watcherKey(attemptId), '1', 'EX', ttlSeconds).catch(() => undefined)
}

export async function stopWatching(attemptId: string): Promise<void> {
  if (!hasRedis) return
  // Other tabs can still be watching. Let the short TTL expire naturally;
  // remaining viewers keep refreshing it.
}

export async function isWatched(attemptId: string): Promise<boolean> {
  if (!hasRedis) return false
  return (await getRedis().exists(watcherKey(attemptId)).catch(() => 0)) === 1
}

export interface Screencast {
  stop: () => Promise<void>
}

/**
 * Starts streaming a page to whoever is watching this attempt.
 *
 * Never throws: a live view that cannot start is a missing convenience, and
 * failing the application it was meant to show would be a poor trade.
 */
export async function startScreencast(params: {
  page: Page
  userId: string
  attemptId: string
  /** Dependency seams for offline tests, never exposed by HTTP. */
  watcherCheck?: typeof isWatched
  emit?: typeof publishAttemptEvent
  pollMs?: number
}): Promise<Screencast> {
  const { page, userId, attemptId } = params
  const watched = params.watcherCheck ?? isWatched
  const emit = params.emit ?? publishAttemptEvent
  let stopped = false
  let checking = false
  let running = false
  let seq = 0
  let lastFrameAt = 0
  let lastSnapshotAt = 0
  const session = await page.context().newCDPSession(page).catch(() => null)
  const publish = (data: string) => {
    if (stopped) return
    seq += 1
    lastFrameAt = Date.now()
    emit(userId, { type: 'frame', attemptId, seq, data })
  }
  session?.on('Page.screencastFrame', (frame: { data: string; sessionId: number }) => {
    void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
    if (running && Date.now() - lastFrameAt >= MIN_FRAME_GAP_MS) publish(frame.data)
  })
  const refresh = async () => {
    if (stopped || checking) return
    checking = true
    try {
      const shouldRun = await watched(attemptId)
      if (stopped) return
      if (!shouldRun) {
        if (running) await session?.send('Page.stopScreencast').catch(() => undefined)
        running = false
        return
      }
      if (!running) {
        running = true
        await session?.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1200, maxHeight: 900, everyNthFrame: 1 }).catch(() => undefined)
        lastSnapshotAt = 0
      }
      // A late viewer must get a frame even if the page is completely static.
      // Also provides a fallback for browser providers without CDP screencast.
      if (!stopped && Date.now() - lastSnapshotAt >= 5_000) {
        lastSnapshotAt = Date.now()
        const image = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 5_000 })
        publish(image.toString('base64'))
      }
    } catch (error) {
      if (!stopped) logger.debug({ err: error, attemptId }, 'live frame temporarily unavailable')
    } finally { checking = false }
  }
  const timer = setInterval(() => void refresh(), params.pollMs ?? 1_000)
  timer.unref()
  void refresh()
  return { async stop() {
    stopped = true
    clearInterval(timer)
    await session?.send('Page.stopScreencast').catch(() => undefined)
    await session?.detach().catch(() => undefined)
  } }
}

/* ------------------------------------------------------------------ takeover */

export interface TakeoverEvent {
  kind: 'click' | 'key' | 'scroll' | 'release'
  x?: number
  y?: number
  text?: string
  deltaY?: number
}

function controlKey(attemptId: string): string {
  return `huntly:takeover:${attemptId}`
}

/** The gateway publishes the user's input here; the runner applies it. */
export async function sendTakeover(attemptId: string, event: TakeoverEvent): Promise<void> {
  if (!hasRedis) return
  await getRedis().publish(controlKey(attemptId), JSON.stringify(event)).catch(() => undefined)
}

/**
 * Hands the page to the user for a while.
 *
 * The runner stops driving and forwards input instead — this is a takeover of
 * the same browser, not a video of one. It ends on an explicit release or when
 * the window expires, and the attempt carries on from wherever the user left
 * the page.
 */
export async function awaitTakeover(params: {
  page: Page
  attemptId: string
  windowMs: number
}): Promise<'released' | 'timeout'> {
  const { page, attemptId, windowMs } = params
  if (!hasRedis) return 'timeout'

  const subscriber = getRedis().duplicate()
  const { promise, resolve } = Promise.withResolvers<'released' | 'timeout'>()

  const timer = setTimeout(() => resolve('timeout'), windowMs)
  timer.unref()

  try {
    await subscriber.subscribe(controlKey(attemptId))
    subscriber.on('message', (_channel: string, message: string) => {
      let event: TakeoverEvent
      try {
        event = JSON.parse(message) as TakeoverEvent
      } catch {
        return
      }

      if (event.kind === 'release') {
        resolve('released')
        return
      }

      // Applied best-effort: a mistyped coordinate should not end the takeover.
      void (async () => {
        try {
          if (event.kind === 'click' && typeof event.x === 'number' && typeof event.y === 'number') {
            await page.mouse.click(event.x, event.y)
          } else if (event.kind === 'key' && event.text) {
            await page.keyboard.type(event.text)
          } else if (event.kind === 'scroll' && typeof event.deltaY === 'number') {
            await page.mouse.wheel(0, event.deltaY)
          }
        } catch (error) {
          logger.debug({ err: error, attemptId }, 'could not apply a takeover event')
        }
      })()
    })

    return await promise
  } finally {
    clearTimeout(timer)
    await subscriber.quit().catch(() => undefined)
  }
}
