/** Isolated form-control fixture, not a provider or product-UI acceptance test. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { observe } from '../agent/observe.js'
import { runTool } from '../agent/tools.js'
import { withSubmissionGuard } from '../hunt/apply/submission-guard.js'
import { submitForm } from '../hunt/apply/fill.js'
import { hasStepProgression } from '../agent/navigation-steps.js'
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'})
const page=await browser.newPage()
await page.route('https://fixture.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<body></body>'}))
await page.goto('https://fixture.invalid/apply')
try{
 await page.setContent('<form><p id="student">Are you currently a student?</p><div role="radiogroup" aria-labelledby="student"><button type="submit" role="radio" aria-checked="false" onclick="event.preventDefault();this.setAttribute(\'aria-checked\',\'true\')">Yes</button><button type="submit" role="radio" aria-checked="false" onclick="event.preventDefault();this.setAttribute(\'aria-checked\',\'true\')">No</button></div><label>Email<input type="email" required></label><button id="submit_app" type="submit">Submit application</button></form><script>window.submits=0;document.querySelector(\'form\').onsubmit=e=>{e.preventDefault();window.submits++;document.body.insertAdjacentHTML(\'beforeend\',\'<p>Thank you for applying</p>\')}</script>')
 let fences=0
 await withSubmissionGuard(async()=>{
  const observation=await observe(page)
  const no=observation.elements.find(element=>element.label==='No')!
  assert.equal(no.submits,false)
  const outcome=await runTool({page,observation,files:{},allowedDomains:['fixture.invalid'],dryRun:true},'click',{ref:no.ref})
  assert.equal(outcome.ok,true)
  assert.equal(fences,0)
  assert.equal(await page.evaluate(()=>Reflect.get(window,'submits')),0)
  console.log('PASS Ashby-style submit-typed radio choice is not a final-submit fence')
  const invalid=await submitForm({page,url:'https://boards.greenhouse.io/fixture',dryRun:false})
  assert.equal(invalid.heldBack,'invalid_fields');assert.equal(fences,0)
  console.log('PASS invalid native form does not create irreversible submission intent')
  await page.getByLabel('Email').fill('fixture@example.invalid')
  const final=await submitForm({page,url:'https://boards.greenhouse.io/fixture',dryRun:false})
  assert.equal(final.submitted,true);assert.equal(fences,1);assert.equal(await page.evaluate(()=>Reflect.get(window,'submits')),1)
  console.log('PASS actual final submit invokes the durable fence exactly once')
 },async()=>{fences++})
 await page.setContent('<h2>Step 1 of 2</h2><form><button type="submit" onclick="event.preventDefault();document.querySelector(\'h2\').textContent=\'Step 2 of 2\'">Next</button><button type="submit">Continue</button></form>')
 const observation=await observe(page),next=observation.elements.find(element=>element.label==='Next')!,ambiguous=observation.elements.find(element=>element.label==='Continue')!
 assert.equal(await hasStepProgression(page,next.ref,next.label),true)
 assert.equal(await hasStepProgression(page,ambiguous.ref,ambiguous.label),false)
 const outcome=await runTool({page,observation,files:{},allowedDomains:['fixture.invalid'],dryRun:true},'click',{ref:next.ref})
 assert.equal(outcome.ok,true)
 assert.equal(await page.locator('h2').innerText(),'Step 2 of 2')
 console.log('PASS explicit Next advances only with DOM step proof; ambiguous Continue has no exemption')
}finally{await browser.close();console.log('Fixture browser closed; no login or real application submitted')}
