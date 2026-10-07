// Read the current effect state: a replaced CSS transition can leave an older
// finished Promise pending even after the effect has actually finished.
export async function waitForFiniteUIAnimations(page){
  await page.evaluate(()=>document.fonts.ready);
  await page.waitForFunction(()=>document.getAnimations().every(animation=>
    !Number.isFinite(animation.effect?.getComputedTiming().endTime)||['finished','idle'].includes(animation.playState)));
}
