import assert from 'node:assert/strict';

export async function assertToastClear(page){
  await page.waitForFunction(()=>{const toast=document.querySelector('#toast');return toast?.classList.contains('visible')&&Number(getComputedStyle(toast).opacity)>=.99;});
  const result=await page.evaluate(()=>{
    const nodes=document.querySelectorAll('#toast'),toast=nodes[0],box=toast?.getBoundingClientRect();
    const rect=box?{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height}:null;
    const overlaps=[];
    for(const element of document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,summary,[role=button]')){
      if(toast?.contains(element)||element.closest('[inert]'))continue;
      const bounds=element.getBoundingClientRect(),style=getComputedStyle(element);
      if(!box||style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0||bounds.width<=0||bounds.height<=0||bounds.bottom<=0||bounds.top>=innerHeight||bounds.right<=0||bounds.left>=innerWidth)continue;
      if(box.left<bounds.right&&box.right>bounds.left&&box.top<bounds.bottom&&box.bottom>bounds.top)overlaps.push({tag:element.tagName,id:element.id,label:(element.getAttribute('aria-label')||element.textContent||'').trim().slice(0,80)});
    }
    const anchors=[...document.querySelectorAll('#control-strip,#live-pill,#mobile-control,#room-nav')].map(element=>({element,bounds:element.getBoundingClientRect(),style:getComputedStyle(element)})).filter(({bounds,style})=>bounds.width>0&&bounds.height>0&&bounds.top>innerHeight/2&&bounds.top<innerHeight&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0);
    return {count:nodes.length,position:toast?getComputedStyle(toast).position:null,rect,overlaps,controlTop:anchors.length?Math.min(...anchors.map(({bounds})=>bounds.top)):innerHeight,viewport:{width:innerWidth,height:innerHeight}};
  });
  assert.equal(result.count,1,'feedback has one toast');assert.equal(result.position,'fixed','feedback stays fixed above the control layer');
  assert(result.rect&&result.rect.width>0&&result.rect.height>0,'visible toast has a real current rectangle');
  assert(result.rect.left>=0&&result.rect.right<=result.viewport.width+1&&result.rect.top>=0&&result.rect.bottom<=result.controlTop,JSON.stringify(result));
  assert.deepEqual(result.overlaps,[],'toast must not cover any visible interactive element: '+JSON.stringify(result));
  return result;
}
