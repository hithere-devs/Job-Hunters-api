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

import { describeElement } from './runtime.mjs'
function ashbyChoice({labelText='Are you legally authorized to work in the United States?',extraButton=false,extraLabel=false,type=null,backingType=null,extraBacking=false}={}) {
 const labels=[],buttons=[]
 const entry={querySelectorAll:s=>s==='label'?labels:s==='.ashby-application-form-input-yesno'?[choices]:[],querySelector:()=>null}
 const backing=[]
 const choices={closest:()=>entry,querySelectorAll:s=>s==='button'?buttons:s==='input,select,textarea,a'?backing:[],querySelector:()=>null}
 if(backingType)backing.push({tagName:'INPUT',getAttribute:()=>backingType,parentElement:choices})
 if(extraBacking)backing.push({tagName:'INPUT',getAttribute:()=> 'text',parentElement:choices})
 const makeButton=text=>({tagName:'BUTTON',textContent:text,labels:[],getAttribute:k=>k==='type'?type:null,hasAttribute:()=>false,closest:s=>s==='.ashby-application-form-input-yesno'?choices:null,ownerDocument:{getElementById:()=>null,defaultView:{getComputedStyle:()=>({visibility:'visible',display:'block'})}},getBoundingClientRect:()=>({width:80,height:30})})
 buttons.push(makeButton('Yes'),makeButton('No'));if(extraButton)buttons.push(makeButton('Submit application'))
 const makeLabel=text=>({textContent:text,closest:()=>entry,querySelector:()=>null})
 labels.push(makeLabel(labelText));if(extraLabel)labels.push(makeLabel('Different question?'))
 return buttons.map(describeElement)
}
test('Ashby native Yes/No buttons carry their sole local label and strict boolean choice',()=>{
 const [yes,no]=ashbyChoice({backingType:'checkbox'})
 assert.equal(yes.type,'checkbox');assert.equal(yes.choiceValue,'true');assert.equal(no.choiceValue,'false')
 assert.equal(no.label,'Are you legally authorized to work in the United States?');assert.equal(no.choiceContext,true)
})
test('unproven or submit-bearing Ashby-like groups cannot become choices',()=>{
 for(const options of [{extraButton:true},{extraLabel:true},{labelText:'Confirm submission?'},{type:'submit'},{backingType:'password'},{backingType:'checkbox',extraBacking:true}]){
  const [button]=ashbyChoice(options)
  assert.equal(button.choiceValue,undefined);assert.equal(button.choiceContext,false)
 }
})
function autocompleteOption({controls='list1',expanded='true',duplicate=false,label='Where are you currently located?',extraLabel=false,visible=true}={}){
 const doc={defaultView:{getComputedStyle:()=>({display:'block',visibility:'visible'})},getElementById:()=>null,querySelectorAll:()=>duplicate?[control,control]:[control]}
 const labelNode={textContent:label,closest:()=>entry,querySelector:()=>null}
 const entry={querySelectorAll:s=>s==='label'?(extraLabel?[labelNode,labelNode]:[labelNode]):s==='[role="combobox"]'?[control]:[]}
 const control={tagName:'INPUT',classList:{contains:n=>n==='ashby-application-form-input-autocomplete'},ownerDocument:doc,getAttribute:k=>({'role':'combobox','aria-controls':controls,'aria-expanded':expanded}[k]??null),getBoundingClientRect:()=>({width:visible?100:0,height:30}),closest:()=>entry}
 const option={tagName:'DIV',textContent:'Bengaluru, Karnataka, India',classList:{contains:n=>n==='ashby-application-form-input-autocomplete-popup-result'},ownerDocument:doc,getAttribute:k=>k==='role'?'option':null,querySelector:()=>null,closest:s=>s==='[role="listbox"]'?{id:'list1'}:null,getBoundingClientRect:()=>({width:200,height:30})}
 return describeElement(option)
}
test('portaled Ashby autocomplete option resolves sole expanded controller and local question',()=>{
 const option=autocompleteOption()
 assert.equal(option.autocompleteChoice,true);assert.equal(option.choiceContext,true);assert.equal(option.label,'Where are you currently located?');assert.equal(option.type,'option')
})
test('disconnected, ambiguous, collapsed or hidden autocomplete owners fail closed',()=>{
 for(const options of [{controls:'other'},{expanded:'false'},{duplicate:true},{extraLabel:true},{visible:false}])assert.equal(autocompleteOption(options).autocompleteChoice,undefined)
})
