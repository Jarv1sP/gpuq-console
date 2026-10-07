// Browser acceptance waits for the rendered state, not a retained `finished`
// promise: Chromium can leave that promise pending after a CSS transition has
// visibly finished. Never finish/cancel animations or disable motion here.
export function finiteAnimationsSettled(){
  return document.getAnimations().every(animation=>{
    if(!Number.isFinite(animation.effect?.getComputedTiming().endTime))return true;
    if(!animation.pending&&['finished','idle'].includes(animation.playState))return true;
    if(animation.playState!=='paused')return false;
    const target=animation.effect?.target;
    if(!(target instanceof Element))return false;
    const hidden=target.closest('[hidden],[inert]');
    // Inert transition ghosts can still be visible. Only an explicitly hidden
    // or inert subtree which actually has no rendered boxes is exempt.
    return Boolean(hidden&&target.getClientRects().length===0&&hidden.getClientRects().length===0);
  });
}

export async function settleFiniteAnimations(page,{timeout=5000}={}){
  await page.waitForFunction(()=>document.fonts.status==='loaded',null,{timeout});
  try{
    await page.waitForFunction(finiteAnimationsSettled,null,{polling:'raf',timeout});
  }catch(error){
    const states=await page.evaluate(()=>document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>({
      type:animation.constructor.name,playState:animation.playState,pending:animation.pending,
      currentTime:animation.currentTime,endTime:animation.effect.getComputedTiming().endTime,
      target:animation.effect.target?.tagName+'#'+animation.effect.target?.id,
      hiddenAncestor:Boolean(animation.effect.target?.closest('[hidden],[inert]')),
    })));
    error.message='Finite animations did not naturally settle: '+JSON.stringify(states)+'; '+error.message;
    throw error;
  }
}
