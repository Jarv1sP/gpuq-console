import assert from 'node:assert/strict';
import {MACHINES} from '../dist/machines.js';

// Runs inside the existing real-Portal browser acceptance, before registration.
// These checks exercise focus, session lifetime and reduced-motion behavior.
export async function verifyAuthentication(page,origin,capture){
  await page.addInitScript(()=>{
    window.authIgnitions=[];let wasLit=false;
    new MutationObserver(()=>{
      const dialog=document.querySelector('#login-dialog'),lit=dialog?.classList.contains('wordmark-ignition');
      if(lit&&!wasLit)window.authIgnitions.push([...dialog.querySelectorAll('.auth-lambda')].map(node=>Number.parseFloat(getComputedStyle(node).animationDuration)));
      wasLit=Boolean(lit);
    }).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
  });
  await page.goto(origin);await page.locator('#login-dialog[open]').waitFor();
  await page.waitForFunction(()=>window.authIgnitions.length===1);
  assert.deepEqual(await page.evaluate(()=>window.authIgnitions),[[.6]],'both Lambda glyphs share the approved 600ms ignition path');
  assert.equal(await page.locator('.auth-r5-wordmark.wordmark').getAttribute('viewBox'),'0 0 9753 711');
  assert.equal(await page.locator('.auth-r5-wordmark>path').count(),2);
  assert.equal(await page.locator('.auth-lambda').evaluate(node=>(node.getAttribute('d').match(/M/g)||[]).length),2,'the supplied animated path contains both Lambda glyphs');
  await page.waitForFunction(()=>!document.querySelector('#login-dialog').classList.contains('wordmark-ignition'));
  const portraits=page.locator('.auth-login-fleet figure');
  assert.equal(await page.locator('.auth-login-fleet').getAttribute('aria-hidden'),'true');
  assert.equal(await portraits.count(),4);
  assert.deepEqual(await portraits.evaluateAll(nodes=>nodes.map(node=>node.querySelectorAll('.auth-bay').length)),[8,8,8,8],'the public decoration has fixed geometry');
  assert.equal(await page.locator('#login-dialog [data-auth-machine],#login-dialog figcaption').count(),0);
  assert.equal(await page.locator('.auth-chassis :is(progress,[data-gpu-index],.unknown,.masked,.vram)').count(),0,'public login portraits contain no monitoring or permission readings');
  const boxes=await portraits.evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().toJSON()));
  assert.ok(boxes.every((box,index)=>!index||box.x>boxes[index-1].x));
  assert.ok(Math.max(...boxes.map(box=>box.y+box.height))-Math.min(...boxes.map(box=>box.y+box.height))<1,'the four hardware portraits share one baseline');
  await capture(page,'r5-login-static-1440.png');
  await page.locator('#open-register').click();
  const username=page.locator('#register-form [name=username]');await username.fill('draft-name');
  const info=page.getByRole('button',{name:'注册码',exact:true});
  await info.focus();await page.keyboard.press('Enter');
  const popup=page.locator('#'+await info.getAttribute('aria-controls'));
  await popup.waitFor({state:'visible'});assert.match(await popup.innerText(),/注册后额度为 0/);
  assert.equal(await popup.locator('a').getAttribute('href'),'/guide/start');
  await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'});
  assert.equal(await page.locator('#register-dialog').evaluate(node=>node.open),true,'Escape dismisses the explanation before the registration dialog');
  assert.equal(await username.inputValue(),'draft-name','opening or dismissing help does not alter the registration draft');
  await page.setViewportSize({width:390,height:844});await info.click();await popup.waitFor({state:'visible'});
  const bounds=await popup.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390&&bounds.y>=0&&bounds.y+bounds.height<=844,'tap help stays inside a phone viewport');
  await capture(page,'r5-register-info-390.png');
  await page.locator('#register-title').click();await popup.waitFor({state:'hidden'});await username.click();
  assert.equal(await info.getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('.guide-link').count(),1,'one global guide entry coexists with contextual chapter links');
  await page.locator('#back-to-login').click();
  assert.equal(await page.evaluate(()=>window.authIgnitions.length),1,'returning from registration does not replay ignition');
  await capture(page,'r5-login-static-390.png');
  await page.reload();await page.locator('#login-dialog[open]').waitFor();
  assert.equal(await page.evaluate(()=>window.authIgnitions.length),0,'a reload in the same browser session does not replay ignition');
  await page.setViewportSize({width:1440,height:1050});

  const reduced=await page.context().browser().newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
  const reducedErrors=[],external=[];
  try{
    await reduced.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});
    const staticPage=await reduced.newPage();staticPage.on('pageerror',error=>reducedErrors.push(error.message));
    await staticPage.goto(origin);await staticPage.locator('#login-dialog[open]').waitFor();
    assert.equal(await staticPage.locator('.wordmark-ignition').count(),0);
    assert.deepEqual(await staticPage.locator('.auth-lambda').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).animationName)),['none']);
    await capture(staticPage,'r5-login-reduced-390.png');
    assert.deepEqual(reducedErrors,[]);assert.deepEqual(external,[]);
  }finally{await reduced.close();}
}

export async function verifyPublicLoginInventoryPrivacy(browser,origin,capture){
  const inventory=MACHINES.map((machine,index)=>({...machine,id:'private-directory-fixture-'+(index+1),model:'PRIVATE_MODEL_'+index,memory:(40+index)+' GB',cards:index+2}));
  const context=await browser.newContext({viewport:{width:320,height:844},reducedMotion:'reduce'}),errors=[],external=[];
  try{
    await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});
    await context.route(origin+'/machines.js',route=>route.fulfill({contentType:'text/javascript',body:'export const MACHINES=Object.freeze('+JSON.stringify(inventory)+');'}));
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin);await page.locator('.auth-chassis').first().waitFor();await page.evaluate(()=>document.fonts.ready);
    const login=page.locator('#login-dialog'),html=await login.innerHTML();
    for(const machine of inventory)for(const value of [machine.id,machine.model,machine.memory])assert.ok(!html.includes(value),'the public login does not expose inventory metadata');
    assert.equal(await login.locator('[data-auth-machine],figcaption').count(),0);
    assert.equal(await login.locator('.auth-login-fleet').getAttribute('aria-hidden'),'true');
    assert.deepEqual(await login.locator('.auth-chassis').evaluateAll(nodes=>nodes.map(node=>({hidden:node.getAttribute('aria-hidden'),bays:node.querySelectorAll('.auth-bay').length}))),Array.from({length:4},()=>({hidden:'true',bays:8})),'decoration does not change with the loaded inventory');
    for(const width of [320,390,1440]){
      await page.setViewportSize({width,height:width===1440?1050:844});
      await page.waitForFunction(()=>document.querySelector('#login-dialog').scrollWidth<=document.querySelector('#login-dialog').clientWidth+1);
      await capture(page,'r5-login-decoration-'+width+'.png');
    }
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  }finally{await context.close();}
}
