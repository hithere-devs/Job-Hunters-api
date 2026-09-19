/** Run on the VM as root. Never prints secrets; does not start Chrome. */
import fs from 'node:fs';import crypto from 'node:crypto';import{execFileSync}from'node:child_process';
const root='/opt/huntly/openclaw-runtime/node_modules/openclaw';
// Native messaging refuses writable runtime executables. Preserve that check.
execFileSync('chown',['-R','root:root','/opt/huntly/openclaw-runtime']);
execFileSync('chmod',['-R','go-w','/opt/huntly/openclaw-runtime']);
const {parse}=await import('/opt/huntly/api/node_modules/dotenv/lib/main.js');
const credentials=parse(fs.readFileSync('/etc/huntly/runner.env'));
const provider=credentials.MODEL_PROVIDER||'openrouter';
if(!['openrouter','vertex','deepseek'].includes(provider))throw new Error('OpenClaw supports MODEL_PROVIDER=openrouter, vertex, or deepseek');
if(provider==='openrouter'&&!credentials.OPENROUTER_API_KEY)throw new Error('Verified OpenRouter model key is required');
if(provider==='vertex'&&!credentials.GOOGLE_CLOUD_PROJECT)throw new Error('GOOGLE_CLOUD_PROJECT is required for Vertex AI');
if(provider==='deepseek'&&!credentials.DEEPSEEK_API_KEY)throw new Error('DEEPSEEK_API_KEY is required for DeepSeek V4.1 Flash');
const model=credentials.APPLY_AGENT_MODEL||credentials.MODEL_DEFAULT||(provider==='deepseek'?'deepseek-flash':'google/gemini-3.1-flash-lite');
const vertexModel=model.replace(/^google-vertex\//,'').replace(/^google\//,'');
const deepseekModel=model.replace(/^deepseek\//,'')||'deepseek-flash';
const modelRef=provider==='vertex'?`google-vertex/${vertexModel}`:provider==='deepseek'?`huntly-deepseek/${deepseekModel}`:`openrouter/${model}`;
const outputCap=Number(credentials.APPLY_AGENT_MAX_TOKENS||2048);
if(!Number.isInteger(outputCap)||outputCap<256||outputCap>16384)throw new Error('Invalid application model output cap');
const base=19789,stride=1000;
const selectedProfiles=JSON.parse(credentials.OPENCLAW_BROWSER_PROFILES||'{}');
if(!selectedProfiles||Array.isArray(selectedProfiles)||typeof selectedProfiles!=='object'||Object.entries(selectedProfiles).some(([i,p])=>!/^([1-9]|10)$/.test(i)||!['tenant','extension-test'].includes(p)))throw new Error('Invalid per-tenant browser profile selection');
const registryPath='/etc/huntly/openclaw-tenants.json';
const registry=fs.existsSync(registryPath)?JSON.parse(fs.readFileSync(registryPath,'utf8')):{};
fs.mkdirSync('/run/huntly-openclaw',{recursive:true,mode:0o711});fs.chmodSync('/run/huntly-openclaw',0o711);
for(let i=1;i<=10;i++){try{execFileSync('systemctl',['stop',`openclaw-gateway-huntly-u${i}`],{stdio:'ignore'});}catch{}}
for(let i=1;i<=10;i++){
 const user=`huntly-u${i}`,home=`/home/${user}`,state=`${home}/.openclaw-${user}`,port=base+(i-1)*stride;
 const uid=Number(execFileSync('id',['-u',user],{encoding:'utf8'}).trim()),gid=Number(execFileSync('id',['-g',user],{encoding:'utf8'}).trim());
 const selectedProfile=selectedProfiles[i]??'tenant';
 const token=registry[i]?.token??crypto.randomBytes(32).toString('hex');registry[i]={port,token};
 for(const dir of [state,`${state}/workspace`,`${state}/workspace/uploads`,`${home}/.cache`]){fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chownSync(dir,uid,gid);fs.chmodSync(dir,0o700);}
 const extraPlugin=provider==='vertex'?'google':provider==='openrouter'?'openrouter':null
 const pluginAllow=['browser','huntly-application-guard',...(extraPlugin?[extraPlugin]:[])]
 const pluginDeny=provider==='deepseek'?['deepseek']:[]
 const pluginEntries={'memory-core':{enabled:false},perplexity:{enabled:false},deepseek:{enabled:false},browser:{enabled:true},'huntly-application-guard':{enabled:true},...(extraPlugin?{[extraPlugin]:{enabled:true}}:{})}
 const modelProvider=provider==='vertex'
  ?{'google-vertex':{apiKey:'gcp-vertex-credentials'}}
  :provider==='deepseek'
   ?{'huntly-deepseek':{apiKey:'${HUNTLY_MODEL_API_KEY}',baseUrl:'https://api.deepseek.com/v1',api:'openai-completions',models:[{id:deepseekModel,name:'DeepSeek V4.1 Flash',reasoning:true,input:['text','image'],cost:{input:0.15,output:0.6,cacheRead:0,cacheWrite:0},contextWindow:1_000_000,maxTokens:outputCap,compat:{supportsStore:false}}]}}
   :{openrouter:{apiKey:'${OPENROUTER_API_KEY}'}};
 const configPath=`${state}/openclaw.json`;
 const previous=fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,'utf8')):fs.existsSync(`${configPath}.last-good`)?JSON.parse(fs.readFileSync(`${configPath}.last-good`,'utf8')):{};
 const config={gateway:{mode:'local',port,bind:'loopback',auth:{mode:'token',token},controlUi:{enabled:false}},agents:{defaults:{workspace:`${state}/workspace`,model:{primary:modelRef,fallbacks:[]},models:{[modelRef]:{params:{maxTokens:outputCap}}},thinkingDefault:'low',timeoutSeconds:300,maxConcurrent:1,heartbeat:{every:'0m'},modelPolicy:{allow:[modelRef]}}},models:{mode:'merge',providers:modelProvider},browser:{enabled:true,evaluateEnabled:false,attachOnly:true,defaultProfile:'tenant',profiles:{tenant:{cdpUrl:`http://127.0.0.1:${9200+i}`,attachOnly:true}},tabCleanup:{enabled:false}},tools:{profile:'full',allow:['browser'],loopDetection:{enabled:true},web:{search:{enabled:false},fetch:{enabled:false}}},plugins:{slots:{memory:'none'},allow:pluginAllow,deny:pluginDeny,load:{paths:['/opt/huntly/openclaw-guard']},entries:pluginEntries},meta:previous.meta&&typeof previous.meta==='object'?previous.meta:{lastTouchedVersion:'2026.9.3',migrations:{modelPolicyAllowlist:true}}};
 if(selectedProfile==='extension-test'){config.browser.profiles['extension-test']={driver:'extension',cdpPort:port+12};config.browser.defaultProfile=selectedProfile;config.browser.extensionRelay={allowLegacyAuth:false};}
 fs.writeFileSync(configPath,JSON.stringify(config,null,2),{mode:0o600});fs.chownSync(configPath,uid,gid);
 fs.copyFileSync(configPath,`${configPath}.last-good`);fs.chownSync(`${configPath}.last-good`,uid,gid);fs.chmodSync(`${configPath}.last-good`,0o600);
 const environment={HOME:home,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:configPath,OPENCLAW_GATEWAY_TOKEN:token,HUNTLY_TENANT_INDEX:String(i),HUNTLY_POLICY_PATH:`/run/huntly-openclaw/tenant-${i}.json`,HUNTLY_OPENCLAW_ROOT:root,OPENCLAW_DISABLE_BONJOUR:'1'};
 if(provider==='openrouter')environment.OPENROUTER_API_KEY=credentials.OPENROUTER_API_KEY;
 else if(provider==='deepseek')environment.HUNTLY_MODEL_API_KEY=credentials.DEEPSEEK_API_KEY;
 else {environment.GOOGLE_CLOUD_PROJECT=credentials.GOOGLE_CLOUD_PROJECT;environment.GOOGLE_CLOUD_LOCATION=credentials.GOOGLE_CLOUD_LOCATION||'global';}
 environment.HUNTLY_BROWSER_PROFILE=selectedProfile;
 if(selectedProfile==='extension-test')environment.HUNTLY_EXTENSION_CDP_PORT=String(port+12);
 const envPath=`/etc/huntly/openclaw-${i}.env`;fs.writeFileSync(envPath,Object.entries(environment).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n',{mode:0o600});fs.chmodSync(envPath,0o600);
 if(provider==='vertex')execFileSync('/usr/bin/node',[`${root}/openclaw.mjs`,'--profile',user,'models','auth','paste-api-key','--provider','google-vertex'],{input:'gcp-vertex-credentials',uid,gid,env:{...process.env,...environment},stdio:['pipe','ignore','ignore']});
 fs.writeFileSync(`/etc/systemd/system/openclaw-gateway-${user}.service`,`[Unit]\nDescription=Huntly isolated OpenClaw tenant ${i}\nAfter=network-online.target huntly-vm-agent.service\nWants=network-online.target\n[Service]\nUser=${user}\nGroup=${user}\nWorkingDirectory=${state}/workspace\nEnvironmentFile=${envPath}\nExecStart=/usr/bin/node ${root}/openclaw.mjs --profile ${user} gateway run --bind loopback --port ${port}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nKillSignal=SIGTERM\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=${state} ${home}/run ${home}/.cache\n[Install]\nWantedBy=multi-user.target\n`);
 console.log(`Provisioned ${user}: gateway ${port}, existing CDP ${9200+i}, private state ${state}`);
}
fs.writeFileSync(registryPath,JSON.stringify(registry),{mode:0o600});fs.chmodSync(registryPath,0o600);
execFileSync('systemctl',['daemon-reload']);
