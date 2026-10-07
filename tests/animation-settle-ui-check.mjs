import assert from 'node:assert/strict';
import {waitForFiniteUIAnimations} from './animation-settle.mjs';

export async function checkAnimationSettling(browser){
  const context=await browser.newContext(),page=await context.newPage();
  try{
    await page.setContent('<div id="probe">animation fixture</div>');
    await page.evaluate(()=>{
      window.fixtureAnimation=document.querySelector('#probe').animate([{opacity:0},{opacity:1}],{duration:1000,fill:'forwards'});
      fixtureAnimation.pause();
      Object.defineProperty(fixtureAnimation,'finished',{get:()=>new Promise(()=>{})});
      const original=document.getAnimations.bind(document);window.settleSamples=0;
      document.getAnimations=()=>{settleSamples++;return original();};
    });
    let returned=false;const waiting=waitForFiniteUIAnimations(page).then(()=>{returned=true;});
    await page.waitForFunction(()=>settleSamples>0);
    assert.equal(returned,false,'paused finite effects are not treated as settled');
    await page.evaluate(()=>fixtureAnimation.finish());
    const oldReturned=await page.evaluate(()=>Promise.race([
      Promise.allSettled(document.getAnimations().map(animation=>animation.finished)).then(()=>true),
      new Promise(resolve=>setTimeout(()=>resolve(false),50))
    ]));
    assert.equal(oldReturned,false,'the old Promise waiter remains stuck after the actual effect finishes');
    await waiting;
    assert.equal(await page.evaluate(()=>fixtureAnimation.playState),'finished');
    assert.equal(await page.locator('#probe').evaluate(el=>getComputedStyle(el).opacity),'1');
  }finally{await context.close();}
}
