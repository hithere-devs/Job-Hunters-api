import type { TakeoverEvent } from '../hunt/apply/screencast.js'

/** Read-only sockets never forward input, even from a custom WebSocket client. */
export function forwardAttemptInput(readOnly: boolean, raw: string, forward: (event: TakeoverEvent) => void): boolean {
  if(readOnly) return false
  try {
    const event = JSON.parse(raw) as TakeoverEvent
    if(!['click','key','scroll','release'].includes(event.kind)) return false
    forward(event)
    return true
  } catch { return false }
}
