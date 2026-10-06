import assert from 'node:assert/strict';
import {inspectGeometry} from './layout-geometry.mjs';

// Separate label boxes ensure a wrapped help-only line cannot pass.
export const datasetHelpGeometry = {
  roots: ['#cloud-files'],
  labelledHelp: [{buttons: '#page-datasets:not([hidden]) [data-copy-help],#page-datasets:not([hidden]) details.ui-info>summary,body[data-room=datasets] .help-links [data-copy-help],body[data-room=datasets] .help-links>details.ui-info>summary',
    rows: '.copy-caption,.dataset-field-label,.dataset-help-heading,.dataset-upload-heading,.dataset-route-heading,.dataset-book>div,.dataset-title-label,.dataset-cache-admin>header,.dataset-details-cell,.dataset-storage',
    labels: ':scope>h2,:scope>h3,:scope>h4,:scope>label,:scope>a,:scope>.dataset-version-details>summary,:scope>span:not(.copy-help):not(.dataset-route-path)'}],
  siblingSpacing: [{parent: '#cloud-files-list>li', gap: 12}],
  closedDisclosures: ['.cloud-file-details:not([open])'],
};

export async function checkDatasetBodyHelpRegressions(page) {
  const footer=page.locator('.help-links'),label=footer.locator(':scope>a'),help=footer.locator(':scope>.copy-help');
  assert.equal(await label.getAttribute('href'),'/guide/start');
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
  const help = page.locator('[data-dataset-help-source=workspace]');
  assert.equal(await help.count(), 1);
  const button = help.locator('[data-copy-help]');
  const originalStyle = await button.getAttribute('style');
  try {
    // Recreate the old action-group placement with no associated label.
    await help.evaluate(node => document.querySelector('#data-workspace-upload-form>.file-actions').append(node));
    const orphan = await inspectGeometry(page, datasetHelpGeometry);
    assert(orphan.failures.some(row => row.rule === 'orphan-help'), 'an action-group or footer help is rejected');
  } finally {
    await help.evaluate(node => document.querySelector('.dataset-sheet-head>.copy-caption').append(node));
  }
  try {
    await button.evaluate(node => node.style.transform = 'translateY(12px)');
    const displaced = await inspectGeometry(page, datasetHelpGeometry);
    assert(displaced.failures.some(row => row.rule === 'labelled-help-position'), 'a help on a different horizontal centre is rejected');
  } finally {
    await button.evaluate((node, style) => style === null ? node.removeAttribute('style') : node.setAttribute('style', style), originalStyle);
  }
  try {
    await button.evaluate(node => node.style.transform = 'translateX(-120px)');
    const left = await inspectGeometry(page, datasetHelpGeometry);
    assert(left.failures.some(row => row.rule === 'labelled-help-position'), 'a help left of its caption is rejected');
  } finally {
    await button.evaluate((node, style) => style === null ? node.removeAttribute('style') : node.setAttribute('style', style), originalStyle);
  }
  const restored = await inspectGeometry(page, datasetHelpGeometry);
  assert(restored.pass, JSON.stringify(restored.failures));
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
