import assert from 'node:assert/strict';
import {inspectGeometry} from './layout-geometry.mjs';

// Separate label boxes ensure a wrapped help-only line cannot pass.
export const datasetHelpGeometry = {
  roots: ['#cloud-files'],
  compactSearch: '#warehouse-search',
  largeTargets: '.v3-row,.v3-upload-choices>.button,.v4-warehouse-card,.v4-training-card',
  clippedScrollPanels: ['.v3-inspector-overflow .v3-detail-scroll'],
  labelledHelp: [{buttons: '#page-datasets:not([hidden]) [data-copy-help],#page-datasets:not([hidden]) details.ui-info>summary,body[data-room=datasets] .help-links [data-copy-help],body[data-room=datasets] .help-links>details.ui-info>summary',
    rows: '.copy-caption,.dataset-field-label,.dataset-help-heading,.dataset-upload-heading,.dataset-route-heading,.dataset-book>div,.dataset-title-label,.dataset-cache-admin>header,.dataset-details-cell,.dataset-storage',
    labels: ':scope>h2,:scope>h3,:scope>h4,:scope>label,:scope>a,:scope>.dataset-version-details>summary,:scope>span:not(.copy-help):not(.dataset-route-path)'}],
  siblingSpacing: [{parent: '#cloud-files-list>li', gap: 12}],
  closedDisclosures: ['.cloud-file-details:not([open])'],
  disclosureRows: ['.cloud-file-details>summary,#cloud-files-pending>summary,.dataset-version-details>summary'],
  disclosureAfterSpacing: [{details: '.cloud-file-details:not([open])', nextBlocks: '#cloud-files-list>li,#data-workspace-status', gap: 12}],
};

export async function checkDatasetBodyHelpRegressions(page) {
  const footer=page.locator('.help-links'),label=footer.locator(':scope>span:not(.copy-help)'),help=footer.locator(':scope>.copy-help');
  assert.equal(await label.textContent(),'首次使用');
  assert.equal(await help.locator('.copy-help-guide').getAttribute('href'),'/guide/start');
  assert.equal(await help.locator('.copy-help-popup>span').textContent(),'从第一次登录，到一次完整训练。');
  const specification={...datasetHelpGeometry,roots:['#page-datasets']};
  const initial=await inspectGeometry(page,specification);assert(initial.pass,JSON.stringify(initial.failures));
  const original=await label.elementHandle();
  try{
    await label.evaluate(node=>node.remove());
    const orphan=await inspectGeometry(page,specification);
    assert(orphan.failures.some(row=>row.rule==='orphan-help'),'the page footer must have a real label, even outside the drawer');
    await footer.evaluate(node=>{const legacy=document.createElement('details');legacy.className='ui-info';legacy.dataset.legacyHelpRegression='';legacy.innerHTML='<summary aria-label="首次使用说明">ⓘ</summary>';node.append(legacy);});
    const oldGlyph=await inspectGeometry(page,specification);
    assert(oldGlyph.failures.some(row=>row.rule==='orphan-help'&&row.elements.some(element=>element.startsWith('summary'))),'the original legacy footer glyph is also rejected');
  }finally{
    await footer.locator('[data-legacy-help-regression]').evaluateAll(nodes=>nodes.forEach(node=>node.remove()));
    await footer.evaluate((node,link)=>node.prepend(link),original);await original.dispose();
  }
  const restored=await inspectGeometry(page,specification);assert(restored.pass,JSON.stringify(restored.failures));
}

export async function checkDatasetHelpRegressions(page) {
  // The workspace heading is in the upload drawer. Experimental cloud files
  // can be hidden for members; inspect the complete visible drawer instead.
  const specification = {...datasetHelpGeometry, roots: ['#dataset-add-dialog[open]']};
  const help = page.locator('[data-dataset-help-source=workspace]');
  assert.equal(await help.count(), 1);
  const button = help.locator('[data-copy-help]');
  const originalStyle = await button.getAttribute('style');
  try {
    // Recreate the old action-group placement with no associated label.
    await help.evaluate(node => document.querySelector('#data-workspace-upload-form>.file-actions').append(node));
    const orphan = await inspectGeometry(page, specification);
    assert(orphan.failures.some(row => row.rule === 'orphan-help'), 'an action-group or footer help is rejected');
  } finally {
    await help.evaluate(node => document.querySelector('.dataset-sheet-head>.copy-caption').append(node));
  }
  try {
    await button.evaluate(node => node.style.transform = 'translateY(12px)');
    const displaced = await inspectGeometry(page, specification);
    assert(displaced.failures.some(row => row.rule === 'labelled-help-position'), 'a help on a different horizontal centre is rejected');
  } finally {
    await button.evaluate((node, style) => style === null ? node.removeAttribute('style') : node.setAttribute('style', style), originalStyle);
  }
  try {
    await button.evaluate(node => node.style.transform = 'translateX(-120px)');
    const left = await inspectGeometry(page, specification);
    assert(left.failures.some(row => row.rule === 'labelled-help-position'), 'a help left of its caption is rejected');
  } finally {
    await button.evaluate((node, style) => style === null ? node.removeAttribute('style') : node.setAttribute('style', style), originalStyle);
  }
  const restored = await inspectGeometry(page, specification);
  assert(restored.pass, JSON.stringify(restored.failures));
}

export async function checkDatasetDisclosureRegressions(page) {
  const details=page.locator('.cloud-file-details').first(),summary=details.locator(':scope>summary'),label=summary.locator('.dataset-disclosure-label');
  assert.equal(await details.getAttribute('open'),null,'the disclosure starts closed');
  const original=await label.getAttribute('style');
  try{
    await label.evaluate(node=>node.style.transform='translateY(10px)');
    const displaced=await inspectGeometry(page,datasetHelpGeometry);
    assert(displaced.failures.some(row=>row.rule==='disclosure-text-center'),'a top-aligned or displaced disclosure caption is rejected');
  }finally{await label.evaluate((node,style)=>style===null?node.removeAttribute('style'):node.setAttribute('style',style),original);}
  try{
    await page.evaluate(()=>{const style=document.createElement('style');style.id='disclosure-marker-regression';style.textContent='.cloud-file-details>summary::before{content:none!important}';document.head.append(style);});
    const missing=await inspectGeometry(page,datasetHelpGeometry);
    assert(missing.failures.some(row=>row.rule==='disclosure-marker'),'a disclosure with no visible state marker is rejected');
  }finally{await page.locator('#disclosure-marker-regression').evaluate(node=>node.remove());}
  const row=details.locator('..'),rowStyle=await row.getAttribute('style');
  try{
    await row.evaluate(node=>node.style.paddingBottom='20px');
    const space=await inspectGeometry(page,datasetHelpGeometry);
    assert(space.failures.some(row=>row.rule==='disclosure-after-spacing'),'the old record padding after a collapsed disclosure is rejected');
  }finally{await row.evaluate((node,style)=>style===null?node.removeAttribute('style'):node.setAttribute('style',style),rowStyle);}
  const result=await inspectGeometry(page,datasetHelpGeometry);assert(result.pass,JSON.stringify(result.failures));
  assert.equal(await summary.evaluate(node=>getComputedStyle(node,'::before').content),'"▸"');
  await summary.click();
  try{
    assert.equal(await summary.evaluate(node=>getComputedStyle(node,'::before').content),'"▾"');
    assert.equal(await summary.evaluate(node=>node.getAnimations().length),0,'reduced motion keeps the marker static');
    const open=await inspectGeometry(page,datasetHelpGeometry);assert(open.pass,JSON.stringify(open.failures));
  }finally{await summary.click();}
}

export async function checkDatasetSpacingRegressions(page) {
  const actions = page.locator('#cloud-files-list>li').nth(1).locator(':scope>.file-actions');
  const originalStyle = await actions.getAttribute('style');
  try {
    await actions.evaluate(node => node.style.margin = '16px 0');
    const margin = await inspectGeometry(page, datasetHelpGeometry);
    assert(margin.failures.some(row => row.rule === 'sibling-spacing'), 'the old compounded action margins are rejected');
  } finally {
    await actions.evaluate((node, style) => style === null ? node.removeAttribute('style') : node.setAttribute('style', style), originalStyle);
  }
  const details = page.locator('.cloud-file-details:not([open])').first();
  const detailStyle = await details.getAttribute('style');
  try {
    await details.evaluate(node => node.style.paddingBottom = '24px');
    const space = await inspectGeometry(page, datasetHelpGeometry);
    assert(space.failures.some(row => row.rule === 'closed-disclosure-space'), 'collapsed details cannot retain an empty content box');
  } finally {
    await details.evaluate((node, style) => style === null ? node.removeAttribute('style') : node.setAttribute('style', style), detailStyle);
  }
  const restored = await inspectGeometry(page, datasetHelpGeometry);
  assert(restored.pass, JSON.stringify(restored.failures));
}
