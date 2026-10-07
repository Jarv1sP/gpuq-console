import assert from 'node:assert/strict';
// Explicit retained-component test variant. Production public rooms continue
// to hide this experimental entry; no permission or node capability is changed.
export async function experimentalCloudHarness(page){
  const component=page.locator('#cloud-files');
  assert.equal(await component.count(),1);
  if(!await component.getAttribute('data-experimental-test-harness')){
    assert.equal(await component.evaluate(node=>node.hidden),true,'public rooms must not expose experimental cloud copies');
    await component.evaluate(node=>{node.dataset.experimentalTestHarness='true';node.hidden=false;});
  }
  assert.equal(await component.evaluate(node=>node.hidden),false,'test the retained component in its deliberate variant');
}
