import assert from 'node:assert/strict';

// Date is fixed; Playwright leaves the real timers and animations running.
export async function freezeR5Clock(page,fixtureTime){
  await page.clock.setFixedTime(fixtureTime);
}

export async function readMissionGeometry(page){
  // A refresh replaces mission HTML. Lookup, visibility and all dimensions
  // belong to one browser task, with no retired handle between these reads.
  return page.evaluate(()=>{
    const dialog=document.querySelector('#job-mission');
    const dots=dialog?.querySelectorAll('.wb-trajectory li:last-child .d')||[];
    const dot=dots.length===1?dots[0]:null;
    const visible=node=>{
      if(!node?.isConnected||!node.getClientRects().length)return false;
      for(let parent=node;parent;parent=parent.parentElement){
        const style=getComputedStyle(parent);
        if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0)return false;
      }
      const {width,height}=node.getBoundingClientRect();
      return width>0&&height>0;
    };
    const rect=node=>{
      if(!visible(node))return null;
      const {x,y,width,height}=node.getBoundingClientRect();
      return {x,y,width,height};
    };
    return {dialogOpen:dialog?.open===true,dotCount:dots.length,dotVisible:visible(dot),
      body:rect(dialog?.querySelector('.r5-mission-body')),
      timeline:rect(dialog?.querySelector('.wb-trajectory')),lastDot:rect(dot)};
  });
}

export function assertMissionGeometry(geometry){
  assert.equal(geometry.dialogOpen,true,'measure the open live mission');
  assert.equal(geometry.dotCount,1,'the current trajectory has exactly one final dot');
  assert.equal(geometry.dotVisible,true,'the current final dot is visible');
  assert.ok(geometry.body&&geometry.timeline&&geometry.lastDot,'all current mission rectangles must be present');
}
