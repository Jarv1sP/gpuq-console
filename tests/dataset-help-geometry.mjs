import assert from 'node:assert/strict';
import {inspectGeometry} from './layout-geometry.mjs';

// Separate label boxes ensure a wrapped help-only line cannot pass.
export const datasetHelpGeometry = {
  roots: ['#cloud-files'],
  labelledHelp: [{buttons: '#dataset-add-dialog[open] [data-copy-help]',
    rows: '.copy-caption,.dataset-field-label,.dataset-help-heading,.dataset-upload-heading,.dataset-route-heading,.dataset-book>div',
    labels: ':scope>h2,:scope>h3,:scope>h4,:scope>label,:scope>span:not(.copy-help):not(.dataset-route-path)'}],
  siblingSpacing: [{parent: '#cloud-files-list>li', gap: 12}],
  closedDisclosures: ['.cloud-file-details:not([open])'],
};

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
