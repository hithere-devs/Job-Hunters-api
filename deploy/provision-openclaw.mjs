/** Run on the VM as root. Never prints secrets; does not start Chrome. */
import fs from 'node:fs';import crypto from 'node:crypto';import{execFileSync}from'node:child_process';
const root='/opt/huntly/openclaw-runtime/node_modules/openclaw';
// Native messaging refuses writable runtime executables. Preserve that check.
execFileSync('chown',['-R','root:root','/opt/huntly/openclaw-runtime']);
execFileSync('chmod',['-R','go-w','/opt/huntly/openclaw-runtime']);
const {parse}=await import('/opt/huntly/api/node_modules/dotenv/lib/main.js');
const credentials=parse(fs.readFileSync('/etc/huntly/runner.env'));
if(!credentials.ANTHROPIC_API_KEY)throw new Error('Verified Anthropic model key is required');
const base=19789,stride=1000;
const registryPath='/etc/huntly/openclaw-tenants.json';
const registry=fs.existsSync(registryPath)?JSON.parse(fs.readFileSync(registryPath,'utf8')):{};
fs.mkdirSync('/run/huntly-openclaw',{recursive:true,mode:0o711});fs.chmodSync('/run/huntly-openclaw',0o711);
for(let i=1;i<=10;i++){
 const user=`huntly-u${i}`,home=`/home/${user}`,state=`${home}/.openclaw-${user}`,port=base+(i-1)*stride;
 const uid=Number(execFileSync('id',['-u',user],{encoding:'utf8'}).trim()),gid=Number(execFileSync('id',['-g',user],{encoding:'utf8'}).trim());
 const token=registry[i]?.token??crypto.randomBytes(32).toString('hex');registry[i]={port,token};
 for(const dir of [state,`${state}/workspace`,`${state}/workspace/uploads`,`${home}/.cache`]){fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chownSync(dir,uid,gid);fs.chmodSync(dir,0o700);}
 const config={gateway:{mode:'local',port,bind:'loopback',auth:{mode:'token',token},controlUi:{enabled:false}},agents:{defaults:{workspace:`${state}/workspace`,model:{primary:'anthropic/claude-sonnet-5'},timeoutSeconds:300,maxConcurrent:1,heartbeat:{every:'0m'}}},models:{mode:'merge',providers:{anthropic:{baseUrl:'https://api.anthropic.com',api:'anthropic-messages',models:[{id:'claude-sonnet-5',name:'Claude Sonnet 5',reasoning:true,input:['text','image'],contextWindow:200000,maxTokens:8192}]}}},browser:{enabled:true,evaluateEnabled:false,attachOnly:true,defaultProfile:'tenant',profiles:{tenant:{cdpUrl:`http://127.0.0.1:${9200+i}`,attachOnly:true,color:'#2563eb'}},tabCleanup:{enabled:false}},tools:{profile:'full',allow:['browser'],loopDetection:{enabled:true}},plugins:{slots:{memory:'none'},allow:['browser','huntly-application-guard'],load:{paths:['/opt/huntly/openclaw-guard']},entries:{'memory-core':{enabled:false},browser:{enabled:true},'huntly-application-guard':{enabled:true}}}};
 if(credentials.ANTHROPIC_WORKSPACE_ID)config.models.providers.anthropic.headers={'anthropic-workspace-id':credentials.ANTHROPIC_WORKSPACE_ID};
 const configPath=`${state}/openclaw.json`;fs.writeFileSync(configPath,JSON.stringify(config,null,2),{mode:0o600});fs.chownSync(configPath,uid,gid);
 const environment={HOME:home,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:configPath,OPENCLAW_GATEWAY_TOKEN:token,ANTHROPIC_API_KEY:credentials.ANTHROPIC_API_KEY,HUNTLY_TENANT_INDEX:String(i),HUNTLY_POLICY_PATH:`/run/huntly-openclaw/tenant-${i}.json`,HUNTLY_OPENCLAW_ROOT:root,OPENCLAW_DISABLE_BONJOUR:'1'};
 const envPath=`/etc/huntly/openclaw-${i}.env`;fs.writeFileSync(envPath,Object.entries(environment).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n',{mode:0o600});fs.chmodSync(envPath,0o600);
 fs.writeFileSync(`/etc/systemd/system/openclaw-gateway-${user}.service`,`[Unit]\nDescription=Huntly isolated OpenClaw tenant ${i}\nAfter=network-online.target huntly-vm-agent.service\nWants=network-online.target\n[Service]\nUser=${user}\nGroup=${user}\nWorkingDirectory=${state}/workspace\nEnvironmentFile=${envPath}\nExecStart=/usr/bin/node ${root}/openclaw.mjs --profile ${user} gateway run --bind loopback --port ${port}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nKillSignal=SIGTERM\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=${state} ${home}/run ${home}/.cache\n[Install]\nWantedBy=multi-user.target\n`);
 console.log(`Provisioned ${user}: gateway ${port}, existing CDP ${9200+i}, private state ${state}`);
}
fs.writeFileSync(registryPath,JSON.stringify(registry),{mode:0o600});fs.chmodSync(registryPath,0o600);
execFileSync('systemctl',['daemon-reload']);
