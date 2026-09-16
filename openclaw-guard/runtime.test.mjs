import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { describePage, pageFacts } from './runtime.mjs'
function inspect(elements, { pathname='/application', buttons=[] }={}) {
 const document = { defaultView:{getComputedStyle:el=>({display:el.hidden?'none':'block',visibility:'visible',opacity:'1'})}, body:{innerText:'Fixture application'}, querySelectorAll:selector=>selector.startsWith('input,textarea')?elements:buttons }
 const fields = elements.concat(buttons)
 for (const el of fields) { el.getBoundingClientRect=()=>({width:el.hidden?0:100,height:el.hidden?0:30});el.closest=()=>null;el.getAttribute=key=>el[key]??null }
 return runInNewContext(`(${describePage.toString()})()`,{document,location:{pathname}})
}
test('hidden captcha response and optional sign-in header do not block application inspection',()=>{
 const result=inspect([{id:'g-recaptcha-response',hidden:true}],{buttons:[{textContent:'Sign in'}]})
 assert.equal(result.hasAuthentication,false)
})
test('visible password, OTP, and human verification controls block inspection',()=>{
 for(const field of [{type:'password'},{autocomplete:'one-time-code'},{'aria-label':"I'm not a robot",role:'checkbox'},{'aria-label':'Human verification',role:'checkbox'},{'aria-label':'Verify you are human',role:'checkbox'},{'aria-label':'I am human',role:'checkbox'}]) assert.equal(inspect([field]).hasAuthentication,true)
})
test('login route blocks even when credential widget is not visible yet',()=>{
 assert.equal(inspect([],{pathname:'/auth/login'}).hasAuthentication,true)
})
test('hidden off-host iframe is neither inspected nor included; visible off-host frame remains',async()=>{
 const main={url:()=> 'https://example.com',parentFrame:()=>null,evaluate:async()=>({hasAuthentication:false,wizardStep:null})}
 let hiddenReads=0
 const child=(hidden,url)=>({url:()=>url,parentFrame:()=>main,frameElement:async()=>({evaluate:async()=>!hidden,dispose:async()=>{}}),evaluate:async()=>{if(hidden)hiddenReads++;return{hasAuthentication:false}}})
 const page={url:main.url,frames:()=>[main,child(true,'https://www.google.com/recaptcha/hidden'),child(false,'https://foreign.example/frame')]}
 const facts=await pageFacts(page,'t1')
 assert.deepEqual(facts.frameUrls,['https://example.com','https://foreign.example/frame'])
 assert.equal(hiddenReads,0)
})
