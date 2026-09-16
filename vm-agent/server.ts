import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.VM_AGENT_PORT ?? 18900);
const TOKEN = process.env.VM_AGENT_TOKEN ?? '';
const HOST = '127.0.0.1';
const IDLE_MS = 20 * 60 * 1000;
const states = new Map<number, TenantState>();

type Mode = 'connect' | 'idle';
type TenantState = { mode: Mode; child: ReturnType<typeof spawn> | null; pid: number | null; startedAt: number | null; lastActivity: number; expiresAt: string | null; idleTimer?: NodeJS.Timeout };

function state(index: number): TenantState {
  let s = states.get(index);
  if (!s) { s = { mode: 'idle', child: null, pid: null, startedAt: null, lastActivity: Date.now(), expiresAt: null }; states.set(index, s); }
  return s;
}
function validIndex(path: string): number | null { const m = path.match(/^\/tenants\/(\d+)(?:\/|$)/); if (!m) return null; const i = Number(m[1]); return i >= 1 && i <= 10 ? i : null; }
function display(i: number) { return `:${10 + i}`; }
function vncPort(i: number) { return 5900 + i; }
function profile(i: number) { return `/home/huntly-u${i}/profile`; }
function cookieDb(i: number) { return `${profile(i)}/Default/Network/Cookies`; }
function json(res: http.ServerResponse, status: number, body: unknown) { const data = JSON.stringify(body); res.writeHead(status, {'content-type':'application/json','content-length':Buffer.byteLength(data)}); res.end(data); }
async function cookies(i: number): Promise<string[]> {
  const db = cookieDb(i); if (!existsSync(db)) return [];
  try { const { stdout } = await execFileAsync('sqlite3', ['-readonly', db, 'select distinct host_key from cookies;']); return stdout.split(/\r?\n/).map(x=>x.trim()).filter(Boolean); } catch { return []; }
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
  const args = ['--user-data-dir='+profile(i), '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-features=TranslateUI', '--window-size=1440,900', '--window-position=0,0', '--start-maximized', 'about:blank'];
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
  if (method==='POST' && path.endsWith('/stop')) { await stopProcess(i); return json(res,200,{stopped:true}); }
  if (method==='POST' && path.endsWith('/disconnect')) { await stopProcess(i); return json(res,200,{stopped:true,cookieDomains:await cookies(i)}); }
  if (method==='GET' && path.endsWith('/status')) { let bytes=0; try { const {stdout}=await execFileAsync('du',['-sb',profile(i)]); bytes=Number(stdout.split(/\s+/)[0])||0; } catch {} return json(res,200,{mode:s.mode,pid:s.pid,uptimeMs:s.startedAt?Date.now()-s.startedAt:0,profileBytes:bytes}); }
  if (method==='GET' && path.endsWith('/cookies')) { if (s.mode!=='idle') return json(res,409,{error:'browser_running'}); return json(res,200,{domains:await cookies(i)}); }
  return json(res,404,{error:'not_found'});
}
if (!TOKEN) console.warn('VM_AGENT_TOKEN is empty; authentication disabled');
http.createServer((req,res)=>{ route(req,res).catch(e=>json(res,500,{error:'internal',message:String(e)})); }).listen(PORT,HOST,()=>console.log(`vm-agent listening on ${HOST}:${PORT}`));
