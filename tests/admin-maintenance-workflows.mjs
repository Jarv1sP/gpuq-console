export async function openMaintenance(page){
  await page.evaluate(()=>location.hash='#admin/maintenance');
  await page.locator('#admin-content #admin-maintenance-console').waitFor({state:'visible'});
}
