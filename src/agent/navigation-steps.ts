import type { Page } from 'playwright-core'
import { refSelector } from './observe.js'
export function explicitStepLabel(label:string){return /^(next(?: step)?|back|save\s*(?:and|&|-)\s*continue)[\s›»→]*$/i.test(label.trim())}
/** A model's assertion is not proof. Inspect a visible, finite progression in the DOM. */
export async function hasStepProgression(page:Page,ref:number,label:string){
 if(!explicitStepLabel(label))return false
 return page.locator(refSelector(ref)).evaluate((element,back)=>{
  const scope=element.closest('form')?.parentElement??document
  const candidates=Array.from(scope.querySelectorAll<HTMLElement>('h1,h2,h3,h4,legend,[role="heading"],[class*="step"],[class*="Step"],[aria-live]'))
  for(const node of candidates){
   const rect=node.getBoundingClientRect()
   if(!rect.width||!rect.height)continue
   const text=node.innerText.trim()
   if(text.length>120)continue
   const match=/\bstep\s*(\d+)\s*(?:of|\/)\s*(\d+)\b/i.exec(text)
   if(match){const current=Number(match[1]),total=Number(match[2]);if(total>1&&(back?current>1:current<total))return true}
  }
  const current=scope.querySelector<HTMLElement>('[aria-current="step"]')
  const list=current?.closest('ol,[role="list"],[role="tablist"]')
  if(current&&list){
   const steps=Array.from(list.children),index=steps.findIndex(step=>step===current||step.contains(current))
   if(index>=0&&steps.length>1&&(back?index>0:index<steps.length-1))return true
  }
  return false
 },/^back/i.test(label))
}
export function authenticationPage(url:string){try{const parsed=new URL(url);return /\/(?:login|sign-?in|sign-?up|auth)(?:\/|$)/i.test(parsed.pathname)||parsed.hostname==='accounts.google.com'}catch{return true}}

/** Native button type is not decisive: some component libraries put submit on radio options. */
export async function isQuestionChoice(page:Page,ref:number){
 return page.locator(refSelector(ref)).evaluate(element=>{
  const role=element.getAttribute('role')
  if(!['radio','option','checkbox'].includes(role??''))return false
  const group=element.closest('[role="radiogroup"],[role="listbox"],[role="group"],fieldset')
  if(!group)return false
  const labelled=Boolean(group.getAttribute('aria-label')||group.getAttribute('aria-labelledby')||group.querySelector('legend'))
  const options=group.querySelectorAll('[role="radio"],[role="option"],[role="checkbox"]')
  return labelled&&options.length>=(role==='checkbox'?1:2)
 })
}
export async function formAllowsSubmit(page:Page,ref:number){
 return page.locator(refSelector(ref)).evaluate(element=>{
  const form=element instanceof HTMLButtonElement||element instanceof HTMLInputElement?element.form:element.closest('form')
  return !form||form.checkValidity()
 })
}
