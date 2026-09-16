export type BrowserMode = 'connect' | 'apply' | 'idle';
export function disconnectAllowed(mode: BrowserMode): boolean { return mode !== 'apply'; }
export function validTenant(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const index = Number(value);
  return Number.isInteger(index) && index >= 1 && index <= 10 ? index : null;
}
export const MAX_RESUME_BYTES = 12 * 1024 * 1024;

/** Old extension CDP clients must not reconnect to a human sign-in browser. */
export function gatewayLifecycleAction(mode:BrowserMode, phase:'before_chrome'|'after_chrome_ready'):'stop'|'start'|null {
  if(mode==='connect'&&phase==='before_chrome')return 'stop';
  if(mode==='apply'&&phase==='after_chrome_ready')return 'start';
  return null;
}
