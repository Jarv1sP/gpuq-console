import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {finiteAnimationsSettled,settleFiniteAnimations} from './animation-settle.mjs';

const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
  const page=await browser.newPage();
  await page.setContent('<main><div id="target">Real finite motion</div><div id="hidden"><div id="paused">Hidden motion</div></div></main>');
  await page.evaluate(()=>{
    const animation=document.querySelector('#target').animate([{transform:'translateX(20px)'},{transform:'none'}],{duration:120,fill:'forwards'});
    // Only the promise is made unresolvable; state/timeline/layout remain real.
    Object.defineProperty(animation,'finished',{get:()=>new Promise(()=>{})});
    window.finiteFixture=animation;
  });
  await settleFiniteAnimations(page);
  assert.ok(await page.evaluate(()=>window.finiteFixture.currentTime>=window.finiteFixture.effect.getComputedTiming().endTime),'visible finite motion must actually reach its timeline end');
  assert.equal(await page.evaluate(()=>window.finiteFixture.playState),'finished');
  assert.equal(await page.locator('#target').evaluate(node=>getComputedStyle(node).transform),'matrix(1, 0, 0, 1, 0, 0)');
  await page.evaluate(()=>{
    window.pausedFixture=document.querySelector('#paused').animate([{opacity:.1},{opacity:1}],{duration:1000,fill:'forwards'});
    window.pausedFixture.pause();
  });
  await assert.rejects(settleFiniteAnimations(page,{timeout:150}),/Finite animations did not naturally settle.*paused/,'visible paused finite motion must reject, not be skipped');
  await page.evaluate(()=>document.querySelector('#hidden').inert=true);
  await assert.rejects(settleFiniteAnimations(page,{timeout:150}),/Finite animations did not naturally settle.*paused/,'visible inert motion is not exempt');
  await page.evaluate(()=>document.querySelector('#hidden').hidden=true);
  assert.equal(await page.evaluate(finiteAnimationsSettled),true,'only a truly non-rendered explicit hidden subtree is exempt');
  await settleFiniteAnimations(page,{timeout:500});
  await page.evaluate(()=>{
    document.querySelector('#hidden').hidden=false;
    document.querySelector('#hidden').inert=false;
    window.pausedFixture.play();
  });
  await settleFiniteAnimations(page);
  assert.equal(await page.evaluate(()=>window.pausedFixture.playState),'finished','revealed finite motion is still awaited naturally');
  await page.evaluate(()=>{
    window.infiniteFixture=document.querySelector('#target').animate([{opacity:.3},{opacity:1}],{duration:1000,iterations:Infinity});
  });
  await settleFiniteAnimations(page,{timeout:500});
  assert.equal(await page.evaluate(()=>window.infiniteFixture.playState),'running','existing infinite telemetry motion is left running');
  console.log(JSON.stringify({status:'passed',checks:['finite visible motion naturally finishes despite an unresolvable finished promise','visible paused rejects with a bounded diagnostic','visible inert paused rejects','explicit hidden non-rendered paused is exempt','revealed motion naturally finishes','infinite telemetry remains running']}));
}finally{await browser.close();}
