import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync, mkdirSync, writeFileSync, chownSync } from 'node:fs';

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.VM_AGENT_PORT ?? 18900);
const TOKEN = process.env.VM_AGENT_TOKEN ?? '';
const HOST = '127.0.0.1';
const IDLE_MS = 20 * 60 * 1000;
const states = new Map<number, TenantState>();

type Mode = 'connect' | 'apply' | 'idle';
type TenantState = { mode: Mode; child: ReturnType<typeof spawn> | null; pid: number | null; startedAt: number | null; lastActivity: number; expiresAt: string | null; idleTimer?: NodeJS.Timeout };

function state(index: number): TenantState {
  let s = states.get(index);
  if (!s) { s = { mode: 'idle', child: null, pid: null, startedAt: null, lastActivity: Date.now(), expiresAt: null }; states.set(index, s); }
  return s;
}
function validIndex(path: string): number | null { const m = path.match(/^\/tenants\/(\d+)(?:\/|$)/); if (!m) return null; const i = Number(m[1]); return i >= 1 && i <= 10 ? i : null; }
function display(i: number) { return `:${10 + i}`; }
function vncPort(i: number) { return 5900 + i; }
function cdpPort(i: number) { return 9200 + i; }
function profile(i: number) { return `/home/huntly-u${i}/profile`; }
function resumePath(i: number) { return `/home/huntly-u${i}/run/huntly-resume.pdf`; }
/**
 * Where Chrome keeps its cookie store.
 *
 * Both paths are real. Chrome moved the store under `Default/Network/` around
 * v96, but the build installed here still writes `Default/Cookies`, and which
 * one you get varies by build and by how the profile was first created. Probing
 * costs one `existsSync` and removes an entire class of silent failure — the
 * first version hardcoded the `Network/` path, found nothing, and returned an
 * empty list that was indistinguishable from "this user never signed in".
 */
const COOKIE_PATHS = ['Default/Cookies', 'Default/Network/Cookies'];

function cookieDb(i: number): string | null {
  for (const candidate of COOKIE_PATHS) {
    const full = `${profile(i)}/${candidate}`;
    if (existsSync(full)) return full;
  }
  return null;
}
function json(res: http.ServerResponse, status: number, body: unknown) { const data = JSON.stringify(body); res.writeHead(status, {'content-type':'application/json','content-length':Buffer.byteLength(data)}); res.end(data); }
export interface CookieRow { host: string; name: string }

/**
 * The cookie store, as `(host, name)` pairs.
 *
 * Names, never values. A cookie *name* is what tells you whether somebody is
 * signed in — `_wellfound` exists only after a Wellfound login — while the
 * value is the credential itself and has no business leaving this machine.
 *
 * Returning only distinct hosts, as the first version did, cannot answer the
 * question being asked. Visiting wellfound.com while logged out still sets
 * `.wellfound.com` analytics cookies, so host presence is evidence of having
 * *loaded the page*, not of having signed in.
 */
async function cookieRows(i: number): Promise<CookieRow[]> {
  const db = cookieDb(i);
  if (!db) {
    // Never silent. An empty answer here fails verification in the UI, and a
    // missing file is a very different problem from an empty profile.
    console.error(`[tenant ${i}] no cookie store found under ${profile(i)} — tried ${COOKIE_PATHS.join(', ')}`);
    return [];
  }
  try {
    const { stdout } = await execFileAsync('sqlite3', [
      '-readonly', '-separator', '\t', db,
      'select distinct host_key, name from cookies;',
    ]);
    const rows = stdout.split(/\r?\n/).map(line => {
      const [host, name] = line.split('\t');
      return host && name ? { host: host.trim(), name: name.trim() } : null;
    }).filter((row): row is CookieRow => row !== null);
    console.log(`[tenant ${i}] read ${rows.length} cookies from ${db}`);
    return rows;
  } catch (error) {
    console.error(`[tenant ${i}] could not read ${db}:`, error instanceof Error ? error.message : error);
    return [];
  }
}

/** Kept for callers that only want hosts. */
async function cookies(i: number): Promise<string[]> {
  return [...new Set((await cookieRows(i)).map(row => row.host))];
}

/**
 * A picture of the tenant's screen, straight off the X display.
 *
 * No CDP involved — that is the whole point of Flow A. `import` talks to the X
 * server, so this works on a browser that has no debugging port and never will.
 * It is the fallback for a platform whose session cookie we do not yet know.
 */
async function screenshot(i: number): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync(
      'sudo',
      ['-u', `huntly-u${i}`, 'env', `DISPLAY=${display(i)}`, 'import', '-window', 'root', 'png:-'],
      { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout as unknown as Buffer;
  } catch (error) {
    console.error(`[tenant ${i}] could not capture the screen:`, error instanceof Error ? error.message : error);
    return null;
  }
}
function stopProcess(i: number): Promise<boolean> {
  const s = state(i); if (!s.child || !s.pid) { s.mode='idle'; s.expiresAt=null; return Promise.resolve(false); }
  const child = s.child; const pid = s.pid; if (s.idleTimer) clearTimeout(s.idleTimer);
  return new Promise(resolve => {
    let done = false; const finish = (forced: boolean) => { if (done) return; done=true; s.mode='idle'; s.child=null; s.pid=null; s.startedAt=null; s.expiresAt=null; resolve(forced); };
    child.once('exit', () => finish(false));
    try { process.kill(pid, 'SIGTERM'); } catch { finish(false); return; }
    setTimeout(() => { if (!done) { console.error(`tenant ${i} Chrome did not exit after SIGTERM; escalating to SIGKILL`); try { process.kill(pid, 'SIGKILL'); } catch {} finish(true); } }, 10_000);
  });
}
async function launch(i: number, mode: Exclude<Mode,'idle'>) {
  const s = state(i); if (s.mode !== 'idle' && s.child) return null;
  // `--hide-crash-restore-bubble`: any ungraceful stop — an agent restart, an
  // OOM — makes Chrome greet the next launch with "Chrome didn't shut down
  // correctly", a bubble that covers the top-right of the page and swallows the
  // first click aimed at what is behind it. Nothing here wants the restore
  // prompt: the profile is what we keep, not the tab list.
  //
  // No `--no-sandbox`, and no automation-hiding flags. Flow A's whole premise
  // is that this browser is genuinely unautomated, and every such flag is
  // detection surface arguing the opposite.
  const args = ['--user-data-dir='+profile(i), '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-features=TranslateUI', '--hide-crash-restore-bubble', '--window-size=1440,900', '--window-position=0,0', '--start-maximized'];
  if (mode === 'apply') args.push('--remote-debugging-port='+cdpPort(i), '--remote-debugging-address=127.0.0.1');
  args.push('about:blank');
  const child = spawn('sudo', ['-u', `huntly-u${i}`, 'env', `DISPLAY=${display(i)}`, 'google-chrome', ...args], {stdio:'ignore'});
  s.mode=mode; s.child=child; s.pid=child.pid ?? null; s.startedAt=Date.now(); s.lastActivity=Date.now(); s.expiresAt=new Date(Date.now()+IDLE_MS).toISOString();
  s.idleTimer = setTimeout(async () => { if (s.mode !== 'idle' && Date.now()-s.lastActivity >= IDLE_MS) await stopProcess(i); }, IDLE_MS + 100);
  child.once('exit', () => { if (s.child === child) { s.mode='idle'; s.child=null; s.pid=null; s.startedAt=null; s.expiresAt=null; } });
  return s;
}
async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, {error:'unauthorized'});
  const method=req.method ?? 'GET', url=new URL(req.url ?? '/', `http://${HOST}:${PORT}`), path=url.pathname;
  if (method==='GET' && path==='/health') return json(res,200,{ok:true,tenants:10,chromeVersion:process.env.CHROME_VERSION ?? 'unknown'});
  const i=validIndex(path); if (i===null) return json(res,404,{error:'not_found'});
  const s=state(i); s.lastActivity=Date.now();
  if (method==='POST' && path.endsWith('/connect')) { if (s.mode!=='idle') return json(res,409,{error:'busy',mode:s.mode}); const x=await launch(i,'connect'); return json(res,200,{mode:'connect',display:display(i),vncPort:vncPort(i),pid:x?.pid ?? null,expiresAt:x?.expiresAt}); }
  if (method==='POST' && path.endsWith('/apply')) { if (s.mode!=='idle') return json(res,409,{error:'busy',mode:s.mode}); const x=await launch(i,'apply'); return json(res,200,{mode:'apply',cdpUrl:`http://127.0.0.1:${cdpPort(i)}`,pid:x?.pid ?? null,expiresAt:x?.expiresAt}); }
  if (method==='PUT' && path.endsWith('/resume')) {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const bytes = Buffer.concat(chunks)
    if (bytes.length === 0 || bytes.length > 12 * 1024 * 1024) return json(res, 400, { error: 'invalid_resume_size' })
    const target = resumePath(i)
    mkdirSync(`/home/huntly-u${i}/run`, { recursive: true })
    writeFileSync(target, bytes, { mode: 0o600 })
    try { chownSync(target, `huntly-u${i}`, `huntly-u${i}`) } catch {}
    return json(res, 200, { path: target, bytes: bytes.length })
  }
  if (method==='POST' && path.endsWith('/stop')) { await stopProcess(i); return json(res,200,{stopped:true}); }
  if (method==='POST' && path.endsWith('/disconnect')) { await stopProcess(i); return json(res,200,{stopped:true,cookieDomains:await cookies(i),cookies:await cookieRows(i)}); }
  // Captured before the browser stops, so the caller can fall back to reading
  // the screen when it cannot recognise a platform's session cookie.
  if (method==='GET' && path.endsWith('/screenshot')) {
    const png = await screenshot(i);
    if (!png) return json(res,503,{error:'screenshot_failed'});
    res.writeHead(200,{'content-type':'image/png','content-length':png.length}); return res.end(png);
  }
  if (method==='GET' && path.endsWith('/status')) { let bytes=0; try { const {stdout}=await execFileAsync('du',['-sb',profile(i)]); bytes=Number(stdout.split(/\s+/)[0])||0; } catch {} return json(res,200,{mode:s.mode,pid:s.pid,uptimeMs:s.startedAt?Date.now()-s.startedAt:0,profileBytes:bytes}); }
  if (method==='GET' && path.endsWith('/cookies')) { if (s.mode!=='idle') return json(res,409,{error:'browser_running'}); return json(res,200,{domains:await cookies(i),cookies:await cookieRows(i)}); }
  return json(res,404,{error:'not_found'});
}
if (!TOKEN) console.warn('VM_AGENT_TOKEN is empty; authentication disabled');
http.createServer((req,res)=>{ route(req,res).catch(e=>json(res,500,{error:'internal',message:String(e)})); }).listen(PORT,HOST,()=>console.log(`vm-agent listening on ${HOST}:${PORT}`));
