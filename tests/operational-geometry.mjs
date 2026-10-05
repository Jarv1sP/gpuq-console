// Extend the shared geometry checks for scrollable sheets. Offscreen DOM
// rectangles must not be mistaken for controls visible through a scroll clip.
// The original control, typography, alignment and containment checks still run
// both outside each scroll area and inside it, without changed tolerances.
import {inspectGeometry} from './layout-geometry.mjs';

export async function inspectOperationalGeometry(page, specification = {}) {
  const {scrollGroups = [], viewportContainment = [],viewportPanels=[],textContainment=[],nonvisualInputs=[],nativeHelpRows=[],wideRows=[], ...shared} = specification;
  // xterm's transparent keyboard/IME bridge is not a visible touch target.
  // An opt-in exclusion is valid only while the actual input stays transparent;
  // showing it is a regression, not a way to bypass the normal geometry rules.
  const invalidInputs=await page.evaluate(selectors=>selectors.flatMap(selector=>
    [...document.querySelectorAll(selector)].filter(node=>!node.matches('textarea.xterm-helper-textarea')||getComputedStyle(node).opacity!=='0')
      .map(node=>({rule:'visible-engine-input',elements:[selector],opacity:getComputedStyle(node).opacity}))),nonvisualInputs);
  const selectedControls = shared.controls || 'button,input,textarea,select,summary,a[href]';
  const controls = nonvisualInputs.length?':is('+selectedControls+'):not('+nonvisualInputs.join(',')+')':selectedControls;
  const excluded = scrollGroups.map(selector => selector + ' *').join(',');
  const result = await inspectGeometry(page, {...shared,
    controls: excluded ? ':is(' + controls + '):not(' + excluded + ')' : controls});
  result.failures.push(...invalidInputs);
  for (const selector of scrollGroups) {
    const area = await inspectGeometry(page, {roots: [selector], controls,
      largeTargets: shared.largeTargets, containment: shared.containment});
    result.failures.push(...area.failures);
    for (const key of Object.keys(result.counts)) result.counts[key] += area.counts[key];
  }
  const visible = await page.evaluate(({roots, controls, viewportContainment,viewportPanels,textContainment,nativeHelpRows,wideRows,checkVisibleOverlap}) => {
    const failures = [], tolerance = 1;
    const rect = node => node.getBoundingClientRect();
    const name = node => node.id ? '#' + node.id : node.tagName.toLowerCase() + '.' + [...node.classList].join('.');
    const intersect = (a, b) => ({left: Math.max(a.left, b.left), right: Math.min(a.right, b.right),
      top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom)});
    const visibleRect = node => {
      if (!node.getClientRects().length || node.closest('[hidden],[inert]') || getComputedStyle(node).visibility === 'hidden') return null;
      let bounds = intersect(rect(node), {left: 0, top: 0, right: innerWidth, bottom: innerHeight});
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (parent.matches('details:not([open])') && !parent.querySelector(':scope>summary')?.contains(node)) return null;
        const style = getComputedStyle(parent), clip = rect(parent);
        if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) {
          bounds.left = Math.max(bounds.left, clip.left); bounds.right = Math.min(bounds.right, clip.right);
        }
        if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)) {
          bounds.top = Math.max(bounds.top, clip.top); bounds.bottom = Math.min(bounds.bottom, clip.bottom);
        }
      }
      return bounds.right > bounds.left && bounds.bottom > bounds.top ? bounds : null;
    };
    const nodes = [...new Set(roots.flatMap(selector => [...document.querySelectorAll(selector)]
      .flatMap(root => [...root.querySelectorAll(controls)])))].map(node => ({node, box: visibleRect(node)})).filter(row => row.box);
    // For normal document flow the shared helper already checks overlap and
    // proves the fixed bottom controls have enough reachable scroll reserve.
    for (let index = 0; checkVisibleOverlap&&index < nodes.length; index++) for (const other of nodes.slice(index + 1)) {
      const one = nodes[index]; if (one.node.contains(other.node) || other.node.contains(one.node)) continue;
      const box = intersect(one.box, other.box);
      if (box.right - box.left > tolerance && box.bottom - box.top > tolerance)
        failures.push({rule: 'visible-overlap', elements: [name(one.node), name(other.node)],
          width: box.right - box.left, height: box.bottom - box.top});
    }
    for (const group of viewportContainment) for (const child of document.querySelectorAll(group.child)) {
      const parent = child.closest(group.parent); if (!parent || !visibleRect(child)) continue;
      const a = rect(child), b = rect(parent);
      if (a.left < b.left - tolerance || a.right > b.right + tolerance || a.top < b.top - tolerance || a.bottom > b.bottom + tolerance)
        failures.push({rule: 'viewport-content-clipping', elements: [name(child), name(parent)],
          child: {left: a.left, right: a.right, top: a.top, bottom: a.bottom},
          parent: {left: b.left, right: b.right, top: b.top, bottom: b.bottom}});
    }
    for (const selector of viewportPanels) for (const node of document.querySelectorAll(selector)) {
      if(!visibleRect(node))continue;
      const box=rect(node);
      if(box.left < -tolerance || box.right > innerWidth+tolerance || box.top < -tolerance || box.bottom > innerHeight+tolerance)
        failures.push({rule:'popup-clipping',elements:[name(node)],left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:innerWidth,height:innerHeight});
    }
    for (const selector of textContainment) for (const node of document.querySelectorAll(selector)) {
      if(!visibleRect(node))continue;
      const range=document.createRange();range.selectNodeContents(node);const box=rect(node);
      for(const line of range.getClientRects())if(line.left<box.left-tolerance||line.right>box.right+tolerance)
        failures.push({rule:'text-clipping',elements:[name(node)],left:line.left,right:line.right,boundaryLeft:box.left,boundaryRight:box.right});
    }
    for(const selector of nativeHelpRows)for(const row of document.querySelectorAll(selector)){
      const label=row.querySelector(':scope>.field-caption>span,:scope>span:not(.ui-info):not(.field-caption)')||row,help=row.querySelector('.ui-info>summary');
      if(!help||!visibleRect(help))continue;
      let labelBox=rect(label);
      if(label===row){
        const text=[...row.childNodes].find(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim());
        if(!text)continue;
        const range=document.createRange();range.selectNodeContents(text);labelBox=range.getBoundingClientRect();
      }
      const helpBox=rect(help),gap=helpBox.left-labelBox.right;
      const centers=[labelBox.top+labelBox.height/2,helpBox.top+helpBox.height/2];
      if(Math.abs(centers[0]-centers[1])>tolerance)
        failures.push({rule:'native-help-center',elements:[name(label),name(help)],values:centers});
      if(gap < -tolerance||gap > 12+tolerance)
        failures.push({rule:'help-label-gap',elements:[name(label),name(help)],gap,maximum:12});
    }
    for(const group of wideRows)if(innerWidth>=group.minimumWidth)for(const parent of document.querySelectorAll(group.parent)){
      const nodes=[...parent.querySelectorAll(group.children)].filter(node=>visibleRect(node));
      if(nodes.length<2)continue;
      const values=nodes.map(node=>rect(node).top);
      if(Math.max(...values)-Math.min(...values)>tolerance)
        failures.push({rule:'wide-row-wrap',elements:nodes.map(name),values,minimumWidth:group.minimumWidth});
    }
    return failures;
  }, {roots: shared.roots || ['body'], controls, viewportContainment,viewportPanels,textContainment,nativeHelpRows,wideRows,checkVisibleOverlap:scrollGroups.length>0});
  result.failures.push(...visible); result.pass = result.failures.length === 0;
  return result;
}

export async function scanOperationalGeometry(page, specification, {widths, heights, zoom = 1}) {
  const results = [];
  for (const height of heights) for (const width of widths) {
    await page.setViewportSize({width: Math.floor(width / zoom), height: Math.floor(height / zoom)});
    await page.evaluate(async () => {
      for (const animation of document.getAnimations()) if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    results.push({physicalWidth: width, physicalHeight: height, zoom, ...await inspectOperationalGeometry(page, specification)});
  }
  return results;
}
