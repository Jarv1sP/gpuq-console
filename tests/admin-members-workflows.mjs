import assert from 'node:assert/strict';

export async function openMembers(page){
  await page.evaluate(()=>location.hash='#admin/members');
  await page.locator('#admin-content #page-users').waitFor({state:'visible'});
  assert.equal(new URL(page.url()).hash,'#admin/members');
}
