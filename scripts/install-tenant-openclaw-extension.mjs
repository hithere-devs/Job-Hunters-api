/** Run as root on the VM. Stages official files only, never approves Chrome UI. */
import assert from 'node:assert/strict'
import {assertOpenClawMaintenance} from './openclaw-fixture-maintenance.mjs'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec=promisify(execFile),tenant=Number(process.argv[2])
assert.ok([2,9].includes(tenant),'Only explicitly authorized test tenants 2 and 9 are supported; tenant3 is protected')
await assertOpenClawMaintenance(tenant,'HUNTLY_EXTENSION_INSTALL_APPROVED')
const home=`/home/huntly-u${tenant}`,user=`huntly-u${tenant}`,root='/opt/huntly/openclaw-runtime/node_modules/openclaw'
const registry=JSON.parse(await readFile('/etc/huntly/openclaw-tenants.json','utf8')),port=registry[String(tenant)].port+12
assert.ok(Number.isInteger(port)&&port>=1024&&port<65536)
const run=async args=>{try{return await exec('sudo',['-u',user,'env',`HOME=${home}`,'node',`${root}/openclaw.mjs`,'--profile',user,...args],{timeout:60000,maxBuffer:1000000})}catch(error){return {stdout:String(error.stdout??''),stderr:String(error.stderr??''),code:error.code}}}
const config=JSON.parse(await readFile(`${home}/.openclaw-${user}/openclaw.json`,'utf8'))
const intended={driver:'extension',cdpPort:port},existing=config.browser?.profiles?.['extension-test']
if(existing)assert.deepEqual(existing,intended,'Refusing to replace a different experimental browser profile')
else {const result=await run(['config','set','browser.profiles.extension-test',JSON.stringify(intended),'--strict-json','--expect-current-absent']);assert.equal(result.code,undefined,'extension profile configuration failed')}
const hardened=await run(['config','set','browser.extensionRelay.allowLegacyAuth','false','--strict-json']);assert.equal(hardened.code,undefined)
const installation=await run(['browser','extension','install','--no-store','--wait-ms','1000','--json'])
let report;try{report=JSON.parse(installation.stdout)}catch{throw new Error('Official extension installer did not return a status report')}
const registration=report.registrations?.find(x=>x.product==='chrome')
if(report.issues?.length||registration?.state!=='owned'){
 console.log(JSON.stringify({gate:'official-extension-bootstrap',manualSetupRequired:report.manualSetupRequired,issues:report.issues,registrationState:registration?.state}))
 throw new Error('Official installer checks failed; do not bypass them')
}
// Chrome on this VM uses a custom --user-data-dir. Preserve any foreign host.
await exec('sudo',['-u',user,'node','-e',`
 const fs=require('fs'),path=require('path');const [src,dest]=process.argv.slice(1),dir=path.dirname(dest);
 fs.mkdirSync(dir,{recursive:true,mode:0o700});const parent=fs.lstatSync(dir);
 if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid()||(parent.mode&0o022))throw Error('Unsafe native host directory');
 if(fs.existsSync(dest)){const stat=fs.lstatSync(dest);if(!stat.isFile()||stat.nlink!==1||!fs.readFileSync(dest).equals(fs.readFileSync(src)))throw Error('Refusing to replace foreign native host')}else fs.copyFileSync(src,dest,fs.constants.COPYFILE_EXCL);
 fs.chmodSync(dest,0o600);
`,registration.manifestPath,`${home}/profile/NativeMessagingHosts/ai.openclaw.browser_bootstrap.json`],{timeout:10000})
const manifest=JSON.parse(await readFile(`${report.installedCopy.path}/manifest.json`,'utf8'))
console.log(JSON.stringify({gate:'extension-staged-not-loaded',tenant,port,path:report.installedCopy.path,name:manifest.name,version:manifest.version,permissions:manifest.permissions,nativeHostOwned:true,manualChromeApprovalRequired:true}))
