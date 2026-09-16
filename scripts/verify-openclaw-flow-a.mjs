import assert from 'node:assert/strict'
import {assertOpenClawMaintenance} from './openclaw-fixture-maintenance.mjs'
import {readFile} from 'node:fs/promises'
import {createConnection} from 'node:net'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
await assertOpenClawMaintenance(2)
const exec=promisify(execFile)
const source=await readFile('/opt/huntly/vm-agent/server.ts','utf8');assert.ok(source.includes('gatewayLifecycleAction'),'new VM lifecycle must be deployed')
const env=await readFile('/etc/huntly/vm-agent.env','utf8');const token=env.match(/^VM_AGENT_TOKEN=(.*)$/m)[1].replace(/^['"]|['"]$/g,'')
const vm=async(path,method='GET')=>{const response=await fetch('http://127.0.0.1:18900/tenants/2'+path,{method,headers:{Authorization:'Bearer '+token}});assert.ok(response.ok,`VM ${path} refused`);return response.json()}
const listening=port=>new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>resolve(false));socket.setTimeout(1000,()=>{socket.destroy();resolve(false)})})
const before=await vm('/status');assert.equal(before.mode,'idle')
const previousGatewayListening=await listening(20789)
let connected=false
try{
 await vm('/connect','POST');connected=true
 const current=await vm('/status')
 const gatewayListening=await listening(20789),cdpListening=await listening(9202),relayListening=await listening(20801)
 const gatewayUnit=(await exec('systemctl',['is-active','openclaw-gateway-huntly-u2']).catch(error=>({stdout:String(error.stdout??'')}))).stdout.trim()
 const args=current.pid?await readFile(`/proc/${current.pid}/cmdline`,'utf8'):''
 const hasDebuggingFlag=args.includes('--remote-debugging')
 const proof={gate:'extension-flow-a-no-debugger',tenant:2,previousGatewayListening,mode:current.mode,gatewayUnit,gatewayPortClosed:!gatewayListening,cdpPortClosed:!cdpListening,relayPortClosed:!relayListening,chromeHasNoDebuggingFlag:!hasDebuggingFlag}
 console.log(JSON.stringify(proof));assert.equal(current.mode,'connect');assert.equal(gatewayUnit,'inactive');assert.equal(gatewayListening,false);assert.equal(cdpListening,false);assert.equal(relayListening,false);assert.equal(hasDebuggingFlag,false)
}finally{if(connected)await vm('/stop','POST')}
console.log(JSON.stringify({gate:'extension-flow-a-cleanup',mode:(await vm('/status')).mode,gatewayPortClosed:!await listening(20789),relayPortClosed:!await listening(20801)}))
