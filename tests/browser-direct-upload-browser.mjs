// Real cross-origin HTTPS bytes, CORS and browser credentials. The only TLS
// exception is for this disposable localhost test certificate.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {directBrowserFixture} from './browser-direct-upload-fixture.mjs';
const shots=process.env.UI_SCREENSHOTS||'/tmp/browser-direct-upload-ui';
const machines=process.env.UI_MACHINE_FIXTURE?JSON.parse(await readFile(process.env.UI_MACHINE_FIXTURE,'utf8')):[{id:'upload-node-example-long-5090',cards:8},{id:'upload-node-example-long-4090-8',cards:8},{id:'upload-node-example-long-4090-6',cards:6},{id:'upload-node-example-long-3090',cards:8}];
const selection=await mkdtemp(join(tmpdir(),'browser-direct-selection-'));
await mkdir(join(selection,'训练'));await writeFile(join(selection,'训练','samples.bin'),Buffer.alloc(2*1024**2+33,7));await writeFile(join(selection,'empty'),'');await mkdir(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const scriptErrors=[],unexpected=[],completed=[];
const waitUntil=async(fn)=>{for(let count=0;count<150;count++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Fixture condition was not reached');};
async function open(fixture,role='member'){
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
  await context.addCookies([{name:'portal_fixture',value:role,url:fixture.origin,httpOnly:true,secure:true,sameSite:'Lax'}]);
  const page=await context.newPage();page.on('pageerror',error=>scriptErrors.push(error.message));
  page.on('request',request=>{if(![fixture.origin,fixture.nodeOrigin].includes(new URL(request.url()).origin))unexpected.push(request.url());});
  await page.goto(fixture.origin);
  await page.evaluate(async({machines,role})=>{
    const {datasetsUI}=await import('/datasets-ui.js');window.toasts=[];window.fetchOptions=[];
    const originalFetch=window.fetch;window.fetch=(url,options)=>{if(String(url).includes('/v1/uploads/'))fetchOptions.push({url:String(url),credentials:options.credentials,method:options.method,redirect:options.redirect});return originalFetch(url,options);};
    window.store={production:true,principal:{userId:role,role},authGeneration:0,
      users:['member','admin','another-member'].map(id=>({id,role:id==='admin'?'admin':'member',enabled:true,limits:Object.fromEntries(machines.map(machine=>[machine.id,machine.cards])),total:machines.reduce((sum,machine)=>sum+machine.cards,0)})),usage(){return 0;},
      data:{machines,datasetUploadAdmission:{protocol:1,available:true}},listeners:[],onAuthChange(listener){this.listeners.push(listener);},async call(operation,args){const response=await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,args})});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{status:response.status});return value.result;}};
    window.renderDatasets=datasetsUI(store,text=>toasts.push(text));renderDatasets();
  },{machines,role});
  await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);
  await page.locator('[data-v3-upload]').first().click();await page.locator('[name=dataset-directory]').setInputFiles(selection);await page.locator('#v3-upload-display').fill('browser-data');
  await page.waitForFunction(()=>document.querySelector('#v3-upload-route').classList.contains('ok')||document.querySelector('#dataset-add-dialog').dataset.v3UploadState==='error');
  return {page,context};
}
try{
  for(const role of ['member','admin']){
    const fixture=await directBrowserFixture(machines);fixture.config.holdChunk=true;fixture.config.holdPublish=true;const {page,context}=await open(fixture,role);
    try{
      assert.match(await page.locator('#v3-upload-route').textContent(),/校园网直连/);assert.equal(fixture.raw.length,0);assert(fixture.probes.length>0,'Preflight is anonymous and has sent zero upload bytes');
      await page.locator('#dataset-upload-start').click();await waitUntil(()=>fixture.held);
      assert.match(await page.locator('#v3-upload-route').textContent(),new RegExp('校园网直连.*'+machines[0].id));
      assert.equal(fixture.calls.some(row=>row.operation.endsWith('.manifest')||row.operation.endsWith('.chunk')),false);
      assert.equal(await page.locator('[data-upload-phase][aria-current]').getAttribute('data-upload-phase'),'transfer');
      for(const width of [1440,390,320]){
        await page.setViewportSize({width,height:1000});await page.locator('#v3-upload-state').scrollIntoViewIfNeeded();
        const layout=await page.evaluate(()=>{const sheet=document.querySelector('#dataset-add-dialog');return {width:innerWidth,body:document.documentElement.scrollWidth,sheet:sheet.scrollWidth,client:sheet.clientWidth,route:document.querySelector('#v3-upload-route').scrollWidth,routeClient:document.querySelector('#v3-upload-route').clientWidth};});
        assert.ok(layout.body<=width+1&&layout.sheet<=layout.client+1&&layout.route<=layout.routeClient+1,JSON.stringify(layout));
        assert.equal(await page.locator('#v3-upload-route .v3-route-end>span[title]').last().getAttribute('title'),machines[0].id);
        await page.screenshot({path:join(shots,`${role}-direct-upload-${width}.png`),fullPage:true});
      }
      fixture.release();await waitUntil(()=>fixture.calls.some(row=>row.operation.endsWith('.commit')));
      await page.waitForFunction(()=>document.querySelector('[data-upload-phase=verify]').hasAttribute('aria-current'));
      assert.equal(await page.locator('[data-upload-phase][aria-current]').getAttribute('data-upload-phase'),'verify');assert.doesNotMatch(await page.locator('#dataset-upload-status').textContent(),/可用于训练/);
      fixture.config.holdPublish=false;await page.waitForFunction(()=>document.querySelector('#dataset-upload-status').dataset.state==='READY');
      assert.equal(['datasets.upload.status','datasets.capacity','datasets.catalog','datasets.overview','datasets.label.get','datasets.label.set'].includes(fixture.calls.at(-1).operation),true);
      assert.match(await page.locator('#dataset-upload-status').textContent(),/可用于训练/);assert.equal(await page.locator('#v3-upload-state [data-use-dataset]').isEnabled(),true);
      assert.ok(fixture.preflights.some(row=>row.headers.includes('authorization')&&row.headers.includes('content-type')),JSON.stringify(fixture.preflights));
      assert.ok(await page.evaluate(()=>fetchOptions.length>0&&fetchOptions.every(row=>row.credentials==='omit'&&row.redirect==='error')));
      assert.equal(await page.evaluate(()=>Object.values(localStorage).some(value=>value.includes('fixture-only-'))),false);
      assert.deepEqual(fixture.failures,[]);completed.push(role+' direct, verify and responsive layout');
    }finally{await context.close();await fixture.close();}
  }
  for(const mode of ['drop','expire','network','bad-ack','commit-drop','mismatch','deny']){
    const fixture=await directBrowserFixture(machines);fixture.config.mode=mode;fixture.config.mismatch=mode==='mismatch';fixture.config.deny=mode==='deny';const {page,context}=await open(fixture);
    try{
      if(mode==='deny'){assert.equal(await page.locator('#dataset-upload-start').isDisabled(),true);assert.equal(fixture.raw.length,0);assert.equal(fixture.calls.some(row=>row.operation==='datasets.upload.begin'||row.operation==='datasets.upload.direct-ticket'),false);assert.match(await page.locator('#v3-upload-state').textContent(),/未授权/);assert.deepEqual(fixture.failures,[]);completed.push('deny before upload intent');continue;}
      await page.locator('#dataset-upload-start').click();
      if(['expire','commit-drop'].includes(mode)){
        await page.waitForFunction(()=>document.querySelector('#dataset-upload-status').dataset.state==='READY');
        if(mode==='expire')assert.equal(fixture.tickets,2);
        if(mode==='commit-drop'){const commit=fixture.calls.findIndex(row=>row.operation.endsWith('.commit'));assert.equal(fixture.calls[commit+1].operation,'datasets.upload.status');assert.equal(fixture.calls.filter(row=>row.operation.endsWith('.commit')).length,1);}
      }else{
        await page.waitForFunction(()=>{const probe=document.querySelector('[data-v3-probe]');return !!probe&&!probe.disabled&&document.querySelector('#dataset-upload-status').dataset.state==='UNKNOWN';});
        assert.equal(await page.locator('[data-upload-phase=ready][aria-current]').count(),0);
        if(mode==='deny'){assert.equal(fixture.raw.length,0);assert.match(await page.locator('#dataset-upload-status').textContent(),/未授权/);}
        else{
          assert.equal(await page.locator('#dataset-upload-query').isVisible(),true);
          if(mode==='mismatch')assert.match(await page.locator('#dataset-upload-status').textContent(),/上传结果与本地清单不符/);
          else{assert.equal(fixture.calls.some(row=>row.operation.endsWith('.manifest')||row.operation.endsWith('.chunk')),false);assert.equal(await page.locator('#v3-relay-options>summary').isVisible(),true,'Relay is a separate explicit choice, never automatically used');}
          if(mode==='drop'){
            const after=fixture.raw.length,uploadId=fixture.raw.at(-1).uploadId;
            await page.locator('#dataset-upload-query').click();assert.equal(fixture.raw.length,after,'Query is read-only');
            await page.locator('#v3-upload-state [data-v3-probe]').last().click();await page.waitForFunction(()=>document.querySelector('#v3-upload-route').classList.contains('ok'));await page.locator('[data-v3-resume]').click();await page.waitForFunction(()=>document.querySelector('#dataset-upload-status').dataset.state==='READY');
            const next=fixture.raw.slice(after);assert.equal(next.find(row=>row.action==='chunk'&&row.path==='训练/samples.bin').offset,1024**2);assert.ok(next.every(row=>row.uploadId===uploadId));assert.equal(fixture.uploads.size,1);
          }
          if(mode==='network'){
            fixture.config.mode='success';const old=fixture.calls.length;await page.locator('#v3-relay-options>summary').click();await page.locator('#v3-relay-options [data-v3-explicit-relay]').click();await page.waitForFunction(()=>document.querySelector('#dataset-upload-status').dataset.state==='READY');
            assert.match(await page.locator('#v3-upload-route').textContent(),/平台中转/);assert.ok(fixture.calls.slice(old).some(row=>row.operation.endsWith('.manifest')));assert.equal(fixture.calls.filter(row=>row.operation.endsWith('.begin')).at(-1).args.allowRelay,true);
          }
        }
      }
      assert.deepEqual(fixture.failures,[]);completed.push(mode);
    }finally{await context.close();await fixture.close();}
  }
  // Size-only scan: test the large missing-endpoint boundary without sending
  // hundreds of MiB or changing the production file picker implementation.
  {
    const fixture=await directBrowserFixture(machines);fixture.config.mode='unavailable';const {page,context}=await open(fixture);
    try{
      await page.evaluate(async machine=>{
        const {uploadBrowserDataset,scanBrowserDirectory}=await import('/dataset-upload.js'),{datasetUploadKeyStore}=await import('/datasets-ui.js');const file=new File(['x'],'sample');const scan=await scanBrowserDirectory([file]);scan.totalBytes=256*1024**2+1;
        try{await uploadBrowserDataset({call:store.call.bind(store),userId:'member',machine,name:'large',scan,keyStore:datasetUploadKeyStore(localStorage),admission:store.data.datasetUploadAdmission});window.largeError='accepted';}catch(error){window.largeError=error.message;}
      },machines[0].id);
      assert.match(await page.evaluate(()=>largeError),/超过 256 MiB/);assert.equal(fixture.raw.length,0);assert.deepEqual(fixture.calls.filter(row=>row.operation.startsWith('datasets.upload.')&&row.operation!=='datasets.upload.routes').map(row=>row.operation),['datasets.upload.admission.create','datasets.upload.begin']);assert.deepEqual(fixture.failures,[]);completed.push('large endpoint denial');
    }finally{await context.close();await fixture.close();}
  }
  {
    const fixture=await directBrowserFixture(machines);fixture.config.holdChunk=true;const {page,context}=await open(fixture);
    try{
      await page.locator('#dataset-upload-start').click();await waitUntil(()=>fixture.held);const before=fixture.raw.length;
      await context.addCookies([{name:'portal_fixture',value:'another-member',url:fixture.origin,httpOnly:true,secure:true,sameSite:'Lax'}]);
      await page.evaluate(()=>{store.authGeneration++;store.principal={userId:'another-member',role:'member'};store.listeners.forEach(listener=>listener());renderDatasets();});fixture.release();
      await page.locator('[data-v3-upload]').first().click();assert.equal(await page.locator('[name=dataset-name]').inputValue(),'');assert.equal(fixture.raw.length,before);assert.doesNotMatch(await page.locator('#page-datasets').textContent(),/browser-data@/);assert.doesNotMatch(await page.locator('#dataset-upload-status').textContent(),/可用于训练/);assert.equal(await page.locator('[data-upload-phase=ready][aria-current]').count(),0);
      const uploadId=[...fixture.uploads.keys()][0];
      assert.equal(await page.evaluate(async uploadId=>{try{await store.call('datasets.upload.status',{machine:store.data.machines[0].id,uploadId});return false;}catch(error){return error.status===403;}},uploadId),true);
      assert.deepEqual(fixture.failures,[]);completed.push('account switch and cross-account refusal');
    }finally{await context.close();await fixture.close();}
  }
  assert.deepEqual(scriptErrors,[]);assert.deepEqual(unexpected,[]);
  console.log('BROWSER DIRECT UPLOAD UI PASS: '+completed.join('; ')+'. Actual raw HTTPS/CORS, credentials omit, no node cookie, verified SHA256, explicit relay only, same upload offsets.');
  console.log('Screenshots: '+shots);
}finally{await browser.close();await rm(selection,{recursive:true,force:true});}
