// Follow the visible shell workflow: open the menu, refresh inside a sheet,
// and return to the room before changing its context.
export async function accountMenu(page){if(await page.locator('#account-menu').count()&&await page.locator('#account-menu').getAttribute('open')===null)await page.locator('#account-menu-toggle').click();}
export async function closeSubmit(page){if(await page.locator('#work-submit-panel[open]').count())await page.locator('#close-submit-panel').click();if(await page.locator('#work-submit[open]').count()){await page.locator('#close-submit').click();await page.locator('#work-submit').waitFor({state:'hidden'});}if(await page.locator('.job-log-dialog[open]').count()){await page.locator('#close-job-log').click();await page.locator('.job-log-dialog').waitFor({state:'hidden'});}}
export async function openSubmit(page){if(await page.locator('#work-submit[open]').count())return;await page.locator('#open-submit').click();await page.locator('#work-submit').waitFor({state:'visible'});}
export async function refreshVisible(page){await page.locator(await page.locator('#work-submit[open]').count()?'#submit-check-refresh':'#refresh-state').click();}
