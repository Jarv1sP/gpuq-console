import assert from 'node:assert/strict';

export async function assertResourceNames(page,root){
  // A viewport change queues ResizeObserver's fitted-name update; measuring
  // immediately can sample the old desktop font inside the new mobile box.
  // Wait for the actual public geometry, never call the production fitter or
  // suppress the assertions below. A permanent overflow still fails bounded.
  await page.evaluate(()=>document.fonts.ready);
  await page.waitForFunction(root=>{
    const labels=[...document.querySelectorAll(root+' .resource-fleet .resource-id-label')];
    return labels.length>0&&labels.every(label=>{
      const range=document.createRange();range.selectNodeContents(label);
      return label.clientWidth>0&&label.scrollWidth<=label.clientWidth+1&&range.getBoundingClientRect().width<=label.clientWidth+1;
    });
  },root,{timeout:5000});
  const names=await page.locator(root+' .resource-fleet .resource-id-label').evaluateAll(labels=>labels.map(label=>{
    const range=document.createRange();range.selectNodeContents(label);
    return {id:label.title,text:label.textContent,width:label.clientWidth,content:label.scrollWidth,
      textWidth:range.getBoundingClientRect().width,font:parseFloat(getComputedStyle(label).fontSize),spacing:parseFloat(getComputedStyle(label).letterSpacing)};
  }));
  assert.ok(names.length,'The fleet must contain real inventory IDs');
  for(const name of names){
    const parts=name.id.split('-'),suffix=parts.slice(parts.length>2?-2:-1).join('-');
    assert.ok(name.text===name.id||name.text.includes('…')&&name.text.endsWith(suffix),
      'Machine ID must be complete or retain its distinguishing suffix: '+JSON.stringify(name));
    assert.ok(name.content<=name.width+1&&name.textWidth<=name.width+1,
      'Machine name must actually fit, including its suffix: '+JSON.stringify(name));
    assert.ok(name.font>=20,'Machine names must stay at least 20px: '+JSON.stringify(name));
    assert.ok(Math.abs(name.spacing+name.font*.045)<=.1,
      'Shrinking the name must also shrink its tracking, without inherited hero-size overlaps: '+JSON.stringify(name));
  }
  assert.equal(new Set(names.map(name=>name.text)).size,new Set(names.map(name=>name.id)).size,
    'Different machines must never collapse to the same visible name');
  return names;
}
