import assert from 'node:assert/strict';
import {inspectGeometry,waitForFontLayout} from './layout-geometry.mjs';

export async function waitForResourceFont(page,family='Archivo') {
  await waitForFontLayout(page);
  await page.waitForFunction(family=>{
    const heading=document.querySelector('.resource-identity');if(!heading)return false;
    const style=getComputedStyle(heading),first=style.fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g,'');
    return first===family&&document.fonts.check(style.fontWeight+' '+style.fontSize+' "'+family+'"',heading.textContent);
  },family);
}

export async function installResourceResizeProbe(page) {
  await page.addInitScript(()=>{
    const NativeResizeObserver=ResizeObserver;
    const probe=globalThis.resourceResizeProbe={hold:false,pending:[],flush(){this.hold=false;for(const deliver of this.pending.splice(0))deliver();}};
    globalThis.ResizeObserver=class extends NativeResizeObserver {
      constructor(callback){super((entries,observer)=>{
        const deliver=()=>callback(entries,observer);
        if(probe.hold&&entries.some(entry=>entry.target.id==='machine-grid'))probe.pending.push(deliver);else deliver();
      });}
    };
  });
}

// Hold one real same-origin font and the identity's resize callback. The old
// comparison uses the actual unsettled layout; product code stays unchanged.
export async function checkDelayedResourceFonts(page,origin) {
  await page.setViewportSize({width:1440,height:1080});await waitForResourceFont(page);
  const desktop=await page.locator('.resource-identity').evaluate(node=>({size:parseFloat(getComputedStyle(node).fontSize),height:node.getBoundingClientRect().height}));
  await page.setViewportSize({width:390,height:844});await waitForResourceFont(page);
  const mobileBefore=await page.locator('.resource-identity').evaluate(node=>parseFloat(getComputedStyle(node).fontSize));
  assert.ok(mobileBefore<desktop.size,'the existing long-ID fixture scales between phone and desktop');
  const fontURL=origin+'/vendor/fonts/Archivo-Variable.woff2?resource-font-readiness-regression=1',family='ResourceReadinessArchivo';
  let releaseFont,observeFont;const fontGate=new Promise(resolve=>releaseFont=resolve),fontObserved=new Promise(resolve=>observeFont=resolve);
  const delayedFont=async route=>{observeFont();await fontGate;await route.continue();};
  await page.route(fontURL,delayedFont);
  try{
    await page.evaluate(({fontURL,family,height})=>{
      const face=new FontFace(family,'url("'+fontURL+'")',{weight:'100 900',stretch:'62% 125%',display:'swap'});
      document.fonts.add(face);globalThis.resourceFontProbe=face;
      const heading=document.querySelector('.resource-identity');heading.style.fontFamily='"'+family+'",Archivo,sans-serif';
      const reference=document.createElement('div');reference.id='resource-font-reference';reference.style.cssText='position:fixed;left:0;top:0;width:1px;height:'+height+'px';document.body.append(reference);
      resourceResizeProbe.hold=true;face.load();
    },{fontURL,family,height:desktop.height});
    await fontObserved;
    await page.setViewportSize({width:1440,height:1080});
    await page.waitForFunction(()=>resourceResizeProbe.pending.length>0&&resourceFontProbe.status==='loading');
    const before=await page.locator('.resource-identity').evaluate(node=>parseFloat(getComputedStyle(node).fontSize));
    assert.equal(before,mobileBefore,'the delayed callback exposes the old mobile baseline');
    const specification={roots:['#resource-identity'],controls:':not(*)',repeatedRowHeights:['#resource-identity,#resource-font-reference']};
    let omittedWaits=0;
    const previousPage={evaluate(callback,...args){
      if(!args.length){assert.match(String(callback),/document\.fonts\.ready/);omittedWaits++;return Promise.resolve();}
      return page.evaluate(callback,...args);
    }};
    const oldGeometry=await inspectGeometry(previousPage,specification);
    assert.equal(omittedWaits,1,'the before check omits only the new font/layout wait');
    assert.equal(oldGeometry.pass,false,'the original measurement sees the unsettled font baseline');
    assert.ok(oldGeometry.failures.some(row=>row.rule==='row-height'));
    const pendingGeometry=inspectGeometry(page,specification);
    releaseFont();
    await page.evaluate(async()=>{await document.fonts.ready;resourceResizeProbe.flush();});
    const geometry=await pendingGeometry;assert.equal(geometry.pass,true,JSON.stringify(geometry.failures));
    await waitForResourceFont(page,family);
    const settled=await page.locator('.resource-identity').evaluate(node=>parseFloat(getComputedStyle(node).fontSize));
    assert.equal(settled,desktop.size,'the loaded typeface restores the real desktop baseline');
    await page.setViewportSize({width:390,height:844});await waitForResourceFont(page,family);
    const mobile=await page.locator('.resource-identity').evaluate(node=>parseFloat(getComputedStyle(node).fontSize));
    assert.throws(()=>assert.ok(mobile<before),{name:'AssertionError'},'the previous resize comparison fails');
    assert.ok(mobile<settled,'the original strict resize comparison passes after waiting');
    return {before,settled,mobile,oldGeometry:oldGeometry.pass,newGeometry:geometry.pass,oldResize:false,newResize:true};
  }finally{
    releaseFont();await page.unroute(fontURL,delayedFont);
    await page.evaluate(()=>{resourceResizeProbe.flush();document.querySelector('.resource-identity').style.removeProperty('font-family');document.querySelector('#resource-font-reference')?.remove();document.fonts.delete(resourceFontProbe);delete globalThis.resourceFontProbe;});
    await waitForResourceFont(page);
  }
}
