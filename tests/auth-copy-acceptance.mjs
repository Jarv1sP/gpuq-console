import assert from 'node:assert/strict';

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
  assert.deepEqual(await page.evaluate(()=>window.authIgnitions),[[.6,.6]],'the two Lambda strokes ignite for the approved 600ms');
  await page.waitForFunction(()=>!document.querySelector('#login-dialog').classList.contains('wordmark-ignition'));
  const portraits=page.locator('[data-auth-machine]');
  assert.deepEqual(await portraits.evaluateAll(nodes=>nodes.map(node=>({id:node.dataset.authMachine,bays:node.querySelectorAll('.auth-bay').length}))),[
    {id:'gpu-1',bays:8},{id:'gpu-2',bays:8},{id:'gpu-3',bays:6},{id:'gpu-4',bays:8},
  ]);
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
    assert.deepEqual(await staticPage.locator('.auth-lambda').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).animationName)),['none','none']);
    await capture(staticPage,'r5-login-reduced-390.png');
    assert.deepEqual(reducedErrors,[]);assert.deepEqual(external,[]);
  }finally{await reduced.close();}
}
