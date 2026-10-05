// Follow progressive disclosure without dropping assertions for any server,
// original per-GPU metric, process column, or queue record.
export const resourceCard=(page,id)=>page.locator(`.resource-card[data-resource-machine="${id}"]`);
export const resourceDetail=(page,id)=>page.locator(`.resource-detail[data-resource-selected="${id}"]`);
export async function selectResource(page,id,{metrics=false}={}){
  if(await page.locator('#resource-sheet[open]').count())await page.locator('[data-resource-back]').click();
  await resourceCard(page,id).locator('.resource-select').click();
  const detail=resourceDetail(page,id);await detail.waitFor({state:'visible'});
  if(metrics){const full=detail.locator(`[data-resource-detail="${id}:metrics"]`);if(await full.count()&&await full.getAttribute('open')===null)await full.locator('summary').first().click();}
  return detail;
}
export async function closeResource(page){if(await page.locator('#resource-sheet[open]').count()){await page.locator('[data-resource-back]').click();await page.locator('#resource-sheet').waitFor({state:'hidden'});}}
