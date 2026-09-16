import http from 'node:http';
import {validAttemptId,validateOpenClawPolicy} from './openclaw-policy.ts';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, chownSync, chmodSync, renameSync, readFileSync, unlinkSync } from 'node:fs';

import { disconnectAllowed, MAX_RESUME_BYTES } from './lifecycle-policy.ts';

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.VM_AGENT_PORT ?? 18900);
const TOKEN = process.env.VM_AGENT_TOKEN ?? '';
const HOST = '127.0.0.1';
const IDLE_MS = 20 * 60 * 1000;
const states = new Map<number, TenantState>();
const operations = new Map<number, Promise<unknown>>();
let shuttingDown = false;
async function exclusive<T>(i: number, operation: () => Promise<T>): Promise<T> {
  const prior = operations.get(i) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(operation);
  operations.set(i, current);
  try { return await current; } finally { if (operations.get(i) === current) operations.delete(i); }
}
function alive(pid: number): boolean { try { process.kill(-pid, 0); return true; } catch { return false; } }


type Mode = 'connect' | 'apply' | 'idle';
type TenantState = { mode: Mode; child: ReturnType<typeof spawn> | null; pid: number | null; startedAt: number | null; lastActivity: number; expiresAt: string | null; idleTimer?: NodeJS.Timeout };

function state(index: number): TenantState {
  let s = states.get(index);
  if (!s) { s = { mode: 'idle', child: null, pid: null, startedAt: null, lastActivity: Date.now(), expiresAt: null }; states.set(index, s); }
  return s;
}
function validIndex(path: string): number | null { const m = path.match(/^\/tenants\/(\d+)(?:\/|$)/); if (!m) return null; const i = Number(m[1]); return i >= 1 && i <= 10 ? i : null; }
function display(i: number) { return `:${i === 10 ? 30 : 10 + i}`; }
function vncPort(i: number) { return 5900 + i; }
function cdpPort(i: number) { return 9200 + i; }
function profile(i: number) { return `/home/huntly-u${i}/profile`; }
function openClawResumePath(i:number,attemptId:string){return `/home/huntly-u${i}/.openclaw-huntly-u${i}/media/inbound/${attemptId}-resume.pdf`;}
async function removeOpenClawPolicy(i:number){
  const file=`/run/huntly-openclaw/tenant-${i}.json`;
  try{const policy=JSON.parse(readFileSync(file,'utf8'));unlinkSync(file);if(validAttemptId(policy.attemptId)){await execFileAsync('sudo',['-u',`huntly-u${i}`,'/usr/bin/node','-e',`try{require('fs').unlinkSync(process.argv[1])}catch(e){if(e.code!=='ENOENT')throw e}`,openClawResumePath(i,policy.attemptId)]);}}catch{}
}
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
async function stopProcess(i: number): Promise<boolean> {
  const s = state(i);
  if (!s.pid) { s.mode='idle'; s.expiresAt=null; await removeOpenClawPolicy(i); return false; }
  const pid=s.pid;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  const deadline=Date.now()+10_000;
  while (alive(pid) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,100));
  const forced=alive(pid);
  if (forced) {
    console.error(`[tenant ${i}] Chrome did not exit after SIGTERM and 10-second wait; escalating process group to SIGKILL`);
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }
  s.mode='idle';s.child=null;s.pid=null;s.startedAt=null;s.expiresAt=null;
  await removeOpenClawPolicy(i);
  return forced;
}
async function launch(i: number, mode: Exclude<Mode,'idle'>) {
  const s = state(i); if (s.mode !== 'idle' && s.child) return null;
  // Sever old interactive clients before switching modes. The X server, not
  // the UI, enforces read-only input during application execution.
  await execFileAsync('systemctl', ['stop', `huntly-novnc@${i}`, `huntly-x11vnc@${i}`]);
  const watchRoot='/run/huntly-vnc-viewonly',marker=`${watchRoot}/${i}`;
  mkdirSync(watchRoot,{recursive:true,mode:0o755});
  if(mode==='apply')writeFileSync(marker,'view-only\n',{mode:0o644});
  else {try{unlinkSync(marker);}catch{}}
  await execFileAsync('systemctl', ['start', `huntly-x11vnc@${i}`, `huntly-novnc@${i}`]);
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
  const child = spawn('sudo', ['-u', `huntly-u${i}`, 'env', `DISPLAY=${display(i)}`, 'google-chrome', ...args], {stdio:'ignore',detached:true});
  s.mode=mode; s.child=child; s.pid=child.pid ?? null; s.startedAt=Date.now(); s.lastActivity=Date.now(); s.expiresAt=new Date(Date.now()+IDLE_MS).toISOString();
  child.once('error', error => { console.error(`[tenant ${i}] Chrome launch failed: ${error.message}`); if (s.child === child) {s.mode='idle';s.child=null;s.pid=null;} });
  child.once('exit', () => { if (s.child === child) { s.mode='idle'; s.child=null; s.pid=null; s.startedAt=null; s.expiresAt=null; } });
  if (mode === 'apply') {
    const deadline=Date.now()+30000; let ready=false;
    while(Date.now()<deadline && s.child===child){
      try {const response=await fetch(`http://127.0.0.1:${cdpPort(i)}/json/version`,{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    if(!ready){await stopProcess(i);throw new Error('Chrome debugging endpoint did not become ready');}
  } else {
    await new Promise(resolve=>setTimeout(resolve,300));
    if(s.child!==child)throw new Error('Chrome exited before the connect session started');
  }
  return s;
}
async function handleTenant(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, {error:'unauthorized'});
  const method=req.method ?? 'GET', url=new URL(req.url ?? '/', `http://${HOST}:${PORT}`), path=url.pathname;
  if (method==='GET' && path==='/health') return json(res,200,{ok:true,tenants:10,chromeVersion:process.env.CHROME_VERSION ?? 'unknown'});
  const i=validIndex(path); if (i===null) return json(res,404,{error:'not_found'});
  const s=state(i);
  if (path.endsWith('/status') || path.endsWith('/connect') || path.endsWith('/resume')) { s.lastActivity=Date.now(); if(s.mode !== 'idle') s.expiresAt=new Date(s.lastActivity+IDLE_MS).toISOString(); }
  if ((method==='POST'||method==='DELETE') && path.endsWith('/openclaw-policy')) {
    let size=0;const chunks:Buffer[]=[];
    for await(const chunk of req){const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=data.length;if(size>400000)return json(res,413,{error:'policy_too_large'});chunks.push(data);}
    let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return json(res,400,{error:'invalid_policy'});}
    if(!body||!validAttemptId(body.attemptId))return json(res,400,{error:'invalid_attempt'});
    const root='/run/huntly-openclaw',file=`${root}/tenant-${i}.json`;
    if(method==='DELETE'){
      if(existsSync(file)){const existing=JSON.parse(readFileSync(file,'utf8'));if(existing.attemptId!==body.attemptId)return json(res,409,{error:'different_attempt'});await removeOpenClawPolicy(i);}
      return json(res,200,{revoked:true});
    }
    if(s.mode!=='apply')return json(res,409,{error:'busy',mode:s.mode});
    const invalid=validateOpenClawPolicy(body,i);if(invalid)return json(res,400,{error:invalid});
    if(existsSync(file)){const old=JSON.parse(readFileSync(file,'utf8'));if(old.deadlineEpoch>Date.now()&&old.attemptId!==body.attemptId)return json(res,409,{error:'policy_busy'});if(old.attemptId===body.attemptId)body.deadlineEpoch=Math.min(old.deadlineEpoch,body.deadlineEpoch);}
    const stagedPath=body.resumePath?openClawResumePath(i,body.attemptId):null;
    if(stagedPath){
      // Copy as the tenant, never write into user-controlled paths as root.
      await execFileAsync('sudo',['-u',`huntly-u${i}`,'/usr/bin/node','-e',
        `const fs=require('fs'),path=require('path');const [src,dest]=process.argv.slice(1);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});try{fs.copyFileSync(src,dest,fs.constants.COPYFILE_EXCL);fs.chmodSync(dest,0o600);}catch(e){if(e.code!=='EEXIST')throw e;const s=fs.lstatSync(dest);if(!s.isFile()||s.nlink!==1)throw Error('Invalid staged resume');}`,
        resumePath(i),stagedPath]);
    }
    mkdirSync(root,{recursive:true,mode:0o711});chmodSync(root,0o711);
    const gid=Number((await execFileAsync('id',['-g',`huntly-u${i}`])).stdout.trim());const tmp=`${file}.tmp`;
    writeFileSync(tmp,JSON.stringify({attemptId:body.attemptId,targetId:body.targetId,deadlineEpoch:body.deadlineEpoch,allowedHosts:body.allowedHosts,approvedFields:body.approvedFields,resumePath:stagedPath}),{mode:0o640});chmodSync(tmp,0o640);chownSync(tmp,0,gid);renameSync(tmp,file);
    return json(res,200,{installed:true,attemptId:body.attemptId,deadlineEpoch:body.deadlineEpoch,resumePath:stagedPath});
  }
  if (method==='POST' && path.endsWith('/connect')) { if (s.mode!=='idle') return json(res,409,{error:'busy',mode:s.mode}); const x=await launch(i,'connect'); return json(res,200,{mode:'connect',display:display(i),vncPort:vncPort(i),pid:x?.pid ?? null,expiresAt:x?.expiresAt}); }
  if (method==='POST' && path.endsWith('/apply')) { if (s.mode!=='idle') return json(res,409,{error:'busy',mode:s.mode}); const x=await launch(i,'apply'); return json(res,200,{mode:'apply',cdpUrl:`http://127.0.0.1:${cdpPort(i)}`,pid:x?.pid ?? null,expiresAt:x?.expiresAt}); }
  if (method==='PUT' && path.endsWith('/resume')) {
    const chunks: Buffer[] = []
    let size=0;
    for await (const chunk of req) { const data=Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size+=data.length; if(size>MAX_RESUME_BYTES) return json(res,413,{error:'invalid_resume_size'}); chunks.push(data); }
    const bytes = Buffer.concat(chunks)
    if (bytes.length === 0 || bytes.length > MAX_RESUME_BYTES) return json(res, 400, { error: 'invalid_resume_size' })
    const target = resumePath(i)
    // The destination is tenant-controlled. Never follow its symlinks as root.
    await new Promise<void>((resolve,reject)=>{
      const child=execFile('sudo',['-u',`huntly-u${i}`,'/usr/bin/node','-e',
        `const fs=require('fs'),path=require('path'),crypto=require('crypto');const dest=process.argv[1],dir=path.dirname(dest),tmp=path.join(dir,'.resume-'+crypto.randomUUID());const chunks=[];process.stdin.on('data',x=>chunks.push(x));process.stdin.on('end',()=>{fs.mkdirSync(dir,{recursive:true,mode:0o700});try{fs.writeFileSync(tmp,Buffer.concat(chunks),{mode:0o600,flag:'wx'});fs.renameSync(tmp,dest);}finally{try{fs.unlinkSync(tmp)}catch{}}});`,target],
        {timeout:30000,maxBuffer:4096},error=>error?reject(error):resolve());
      child.stdin?.on('error',reject);child.stdin?.end(bytes);
    });
    return json(res, 200, { path: target, bytes: bytes.length })
  }
  if (method==='POST' && path.endsWith('/stop')) { await stopProcess(i); return json(res,200,{stopped:true}); }
  if (method==='POST' && path.endsWith('/disconnect')) { if (!disconnectAllowed(s.mode)) return json(res,409,{error:'busy',mode:s.mode}); await stopProcess(i); const rows=await cookieRows(i); return json(res,200,{stopped:true,cookieDomains:[...new Set(rows.map(row=>row.host))],cookies:rows}); }
  // Captured before the browser stops, so the caller can fall back to reading
  // the screen when it cannot recognise a platform's session cookie.
  if (method==='GET' && path.endsWith('/screenshot')) {
    const png = await screenshot(i);
    if (!png) return json(res,503,{error:'screenshot_failed'});
    res.writeHead(200,{'content-type':'image/png','content-length':png.length}); return res.end(png);
  }
  if (method==='GET' && path.endsWith('/status')) { let bytes=0; try { const {stdout}=await execFileAsync('du',['-sb',profile(i)]); bytes=Number(stdout.split(/\s+/)[0])||0; } catch {} return json(res,200,{mode:s.mode,vncReadOnly:s.mode==='apply'&&existsSync(`/run/huntly-vnc-viewonly/${i}`),pid:s.pid,uptimeMs:s.startedAt?Date.now()-s.startedAt:0,profileBytes:bytes}); }
  if (method==='GET' && path.endsWith('/cookies')) { if (s.mode!=='idle') return json(res,409,{error:'browser_running'}); return json(res,200,{domains:await cookies(i),cookies:await cookieRows(i)}); }
  return json(res,404,{error:'not_found'});
}
if (!TOKEN) throw new Error('VM_AGENT_TOKEN is required; refusing to start an unauthenticated VM agent');
const server=http.createServer((req,res)=>{
  if(shuttingDown) return json(res,503,{error:'shutting_down'});
  const url=new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const index=validIndex(url.pathname);
  const work=()=>handleTenant(req,res);
  const task=index===null || url.pathname.endsWith('/status') ? work() : exclusive(index,work);
  void task.catch(error=>{ console.error('VM agent request failed:',error instanceof Error ? error.message : 'unknown');if(!res.headersSent) json(res,500,{error:'internal'}); });
});
const idleSweep=setInterval(()=>{
  for(const [index,s] of states) if(s.mode!=='idle' && Date.now()-s.lastActivity>=IDLE_MS) void exclusive(index,async()=>{if(Date.now()-state(index).lastActivity>=IDLE_MS) await stopProcess(index);});
},15000);
idleSweep.unref();
server.listen(PORT,HOST,()=>console.log(`vm-agent listening on ${HOST}:${PORT}`));
async function shutdown(){
  if(shuttingDown)return;shuttingDown=true;clearInterval(idleSweep);server.close();
  await Promise.all([...states.keys()].map(index=>exclusive(index,()=>stopProcess(index))));
  process.exit(0);
}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
