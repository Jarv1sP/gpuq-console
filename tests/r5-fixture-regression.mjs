import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {guardedRoute} from './browser-route-guard.mjs';
import {freezeR5Clock,readMissionGeometry,assertMissionGeometry} from './r5-fixture-tools.mjs';

export async function runR5FixtureRegression(shots){
  const directory=join(shots,'fixture-regression');await mkdir(directory,{recursive:true});
  const origin='https://r5-fixture.test',fixtureTime=Date.now(),errors=[],outside=[],rows=[];
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const probe=`import {taskMissionUI} from './workbench-ui.js';
import {MACHINES} from './machines.js';
const now=${fixtureTime}/1000,id='controlled-r5-mission';
const job={id,userId:'fixture-member',name:'controlled-mission',machine:MACHINES[0].id,cards:2,state:'RUNNING',createdAt:now-3600,schedulerCheckedAt:now,assignedIndices:[0,1],latestAttempt:{id:'current-attempt',startedAt:now-3255},progress:{reported:true,stale:false,snapshot:{epochsCompleted:12,epochsTotal:40,updatedAt:now,metrics:{loss:.438}}}};
const store={jobs:[job],principal:{userId:job.userId},data:{machines:MACHINES,gpuq:{stale:false,hosts:[]}},onAuthChange(){}};
const mission=taskMissionUI(store),row=document.createElement('article');
row.dataset.workbenchJob=id;row.innerHTML='<button data-job-mission="'+id+'">全屏查看</button>';document.body.append(row);
globalThis.refreshRealMission=()=>{job.progress.snapshot.metrics.loss-=.001;mission.sync();};
globalThis.r5FixtureReady=true;`;

  async function pageFor(fixed){
    const context=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce'}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    // Simulate 61 seconds of fixture preparation without a slow real sleep.
    await page.clock.setFixedTime(fixtureTime+61000);
    if(fixed)await freezeR5Clock(page,fixtureTime);
    await context.route('**/*',guardedRoute(async route=>{
      const url=new URL(route.request().url());if(url.origin!==origin){outside.push(url.href);await route.abort();return;}
      const file=decodeURIComponent(url.pathname.slice(1))||'index.html';assert.ok(!file.includes('..'));
      if(file==='r5-fixture-probe.js'){await route.fulfill({contentType:'text/javascript',body:probe});return;}
      let body=await readFile(new URL('../dist/'+file,import.meta.url));
      if(file==='index.html')body=body.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('</body>','<script type="module" src="./r5-fixture-probe.js"></script></body>');
      const contentType=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':file.endsWith('.ico')?'image/x-icon':'text/html';
      await route.fulfill({contentType,body});
    }));
    await page.goto(origin);await page.waitForFunction(()=>globalThis.r5FixtureReady);await page.evaluate(()=>document.fonts.ready);
    await page.locator('[data-job-mission="controlled-r5-mission"]').click();await page.locator('#job-mission').waitFor({state:'visible'});
    return page;
  }

  try{
    const delayed=await pageFor(false),oldElapsed=await delayed.locator('[data-mission-elapsed]').innerText();
    assert.equal(oldElapsed,'55:16');
    assert.throws(()=>assert.match(oldElapsed,/^54:/),assert.AssertionError,'the original wall-clock prefix fails after 61 seconds');
    await delayed.screenshot({path:join(directory,'clock-old-61s.png')});
    rows.push({case:'61-second preparation',oldAssertion:'FAIL',oldElapsed});

    const current=await pageFor(true),elapsed=await current.locator('[data-mission-elapsed]').innerText();
    assert.equal(elapsed,'54:15','the browser clock uses the exact job fixture baseline');
    await current.screenshot({path:join(directory,'clock-fixed-61s.png')});
    rows.push({case:'same 61-second preparation with fixed fixture clock',newAssertion:'PASS',elapsed});

    // Keep a retired handle only to prove the old test failure. The new
    // measurement below looks up every current node atomically instead.
    const oldDot=await current.locator('#job-mission .wb-trajectory li:last-child .d').elementHandle();assert(oldDot);
    const before=await oldDot.boundingBox();assert(before);
    await current.evaluate(()=>refreshRealMission());
    const retired=await oldDot.boundingBox();assert.equal(retired,null);
    assert.equal(await oldDot.evaluate(node=>node.isConnected),false);
    assert.throws(()=>retired.x,TypeError,'sync retires the handle used by the old asynchronous measurement');
    const geometry=await readMissionGeometry(current);assertMissionGeometry(geometry);
    const {body,timeline,lastDot}=geometry;
    assert.ok(Math.abs(timeline.x+timeline.width-(body.x+body.width))<=1);
    assert.ok(Math.abs(lastDot.x+lastDot.width-(body.x+body.width))<=1,'timeline reaches content edge');
    await current.screenshot({path:join(directory,'sync-current-trajectory.png')});
    rows.push({case:'real taskMissionUI.sync replaces DOM',oldHandle:retired,newAssertion:'PASS',geometry});

    for(const mutation of ['missing','duplicate','display-none','visibility-hidden','opacity-zero','zero-size']){
      await current.evaluate(mutation=>{
        const dot=document.querySelector('#job-mission .wb-trajectory li:last-child .d');
        globalThis.savedR5Dot={dot,parent:dot.parentElement,next:dot.nextSibling,style:dot.getAttribute('style')};
        if(mutation==='missing')dot.remove();
        else if(mutation==='duplicate'){const duplicate=dot.cloneNode(true);duplicate.dataset.regressionDuplicate='true';dot.parentElement.append(duplicate);}
        else if(mutation==='display-none')dot.style.display='none';
        else if(mutation==='visibility-hidden')dot.style.visibility='hidden';
        else if(mutation==='opacity-zero')dot.style.opacity='0';
        else {dot.style.width='0';dot.style.height='0';dot.style.border='0';dot.style.padding='0';}
      },mutation);
      try{
        const invalid=await readMissionGeometry(current);
        assert.throws(()=>assertMissionGeometry(invalid),assert.AssertionError,'invalid current dots must fail: '+mutation);
        assert.equal(invalid.lastDot,null);rows.push({case:mutation,rejected:true,dotCount:invalid.dotCount,dotVisible:invalid.dotVisible});
      }finally{
        await current.evaluate(()=>{
          const {dot,parent,next,style}=globalThis.savedR5Dot;
          document.querySelector('[data-regression-duplicate]')?.remove();
          if(!dot.isConnected)parent.insertBefore(dot,next);
          if(style===null)dot.removeAttribute('style');else dot.setAttribute('style',style);
          delete globalThis.savedR5Dot;
        });
      }
    }
    assertMissionGeometry(await readMissionGeometry(current));
    assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
    await writeFile(join(directory,'results.json'),JSON.stringify({status:'PASS',fixtureTime,preparationDelayMs:61000,rows,errors,outside},null,2));
    console.log(JSON.stringify({status:'passed',checks:['61s: old clock FAIL, fixed clock exact 54:15 PASS','real sync: retired handle null, atomic current geometry PASS','original 1px assertions retained','missing/duplicate/hidden/zero-sized dots explicitly fail'],screenshots:directory}));
  }finally{
    for(const context of browser.contexts()){await context.unrouteAll({behavior:'wait'});await context.close();}
    await browser.close();
  }
}
