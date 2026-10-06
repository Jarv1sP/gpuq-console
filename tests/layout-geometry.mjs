// Reusable rendered-layout checks. Selectors describe component relationships,
// rather than expected CSS declarations. Reports keep every viewport and the
// elements responsible for a failure; scrollable content is checked separately
// from deliberate single-line truncation with an accessible full label.
export const layoutWidths = [...new Set([
  ...Array.from({length: 57}, (_, index) => 320 + index * 40),
  1280, 1366, 1440, 1536, 1680, 1920, 2560,
])].sort((left, right) => left - right);
export const layoutHeights = [700, 900, 1200];
export const layoutZooms = [1, 1.25, 1.5];

export async function waitForFontLayout(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Let font layout and ResizeObserver delivery settle before measuring.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

export async function inspectGeometry(page, specification = {}) {
  await waitForFontLayout(page);
  return page.evaluate(spec => {
    const tolerance = 1;
    const failures = [];
    const counts = {controls: 0, alignments: 0, rows: 0, containment: 0};
    const rect = node => node.getBoundingClientRect();
    const rendered = node => {
      if (!node || !node.getClientRects().length || getComputedStyle(node).visibility === 'hidden' || node.closest('[hidden],[inert]')) return false;
      // Closed disclosure contents and clipped screen-reader links can retain
      // DOM rectangles. They are not currently rendered interactive targets.
      for (let parent = node.parentElement; parent; parent = parent.parentElement)
        if (parent.matches('details:not([open])') && !parent.querySelector(':scope > summary')?.contains(node)) return false;
      const style = getComputedStyle(node);
      return !(style.clip !== 'auto' && rect(node).width <= 1 && rect(node).height <= 1);
    };
    const describe = node => node.id ? '#' + node.id : node.tagName.toLowerCase() +
      [...node.classList].map(value => '.' + value).join('') +
      (node.getAttribute('name') ? '[name="' + node.getAttribute('name') + '"]' : '') +
      (node.getAttribute('aria-label') ? '[aria-label="' + node.getAttribute('aria-label') + '"]' : '');
    const add = (rule, nodes, evidence) => failures.push({rule, elements: nodes.map(describe), ...evidence});
    const select = (selector, root = document) => [...root.querySelectorAll(selector)].filter(rendered);
    const lines = (nodes, wrap) => {
      if (!wrap) return [nodes];
      const groups = [];
      for (const node of nodes) {
        const value = rect(node);
        const group = groups.find(items => items.some(item => {const other = rect(item);
          return Math.min(value.bottom, other.bottom) - Math.max(value.top, other.top) > tolerance;}));
        if (group) group.push(node); else groups.push([node]);
      }
      return groups;
    };
    const roots = (spec.roots || ['body']).flatMap(selector => select(selector));
    if (!roots.length) failures.push({rule: 'missing-root', elements: spec.roots || ['body']});
    const width = innerWidth;
    if (document.documentElement.scrollWidth > width + tolerance || document.body.scrollWidth > width + tolerance)
      failures.push({rule: 'horizontal-scroll', elements: ['html', 'body'], width,
        html: document.documentElement.scrollWidth, body: document.body.scrollWidth,
        overflowing: select('body *').filter(node => {const value = rect(node); return value.left < -tolerance || value.right > width + tolerance;})
          .slice(0, 12).map(node => ({element: describe(node), left: rect(node).left, right: rect(node).right}))});
    const phone = width < 760;
    const selectors = spec.controls || 'button, input:not([type=checkbox]):not([type=radio]), select, summary, a[href]';
    const controls = [...new Set(roots.flatMap(root => select(selectors, root)))];
    const inView = node => {const value = rect(node); return value.bottom > 0 && value.top < innerHeight;};
    const isInlineLink = node => node.matches('.guide-prose a');
    const isRow = node => node.matches(spec.largeTargets || '.guide-card,.maintenance-row,.guide-pagination a');
    for (const node of controls) {
      if (isInlineLink(node)) continue;
      counts.controls++;
      const value = rect(node);
      const compactSearch=phone&&spec.compactSearch&&node.matches(spec.compactSearch);
      if(compactSearch&&(Math.abs(value.height-40)>tolerance||getComputedStyle(node).fontSize!=='14px'))
        add('compact-search', [node], {height:value.height,fontSize:getComputedStyle(node).fontSize,expectedHeight:40,expectedFontSize:14});
      if (phone && !compactSearch && value.height < 44 - tolerance)
        add('touch-height', [node], {height: value.height, minimum: 44});
      if (!phone && node.matches('button,input,select') && !isRow(node) &&
          ![32, 40, 48].some(height => Math.abs(value.height - height) <= tolerance))
        add('control-step', [node], {height: value.height, allowed: [32, 40, 48]});
      if (value.width < 1 || value.height < 1) add('empty-target', [node], {width: value.width, height: value.height});
    }
    for (const selectors of spec.leftEdges || []) {
      const nodes = selectors.flatMap(selector => select(selector));
      if (nodes.length < 2) continue;
      counts.alignments++;
      const values = nodes.map(node => rect(node).left);
      if (Math.max(...values) - Math.min(...values) > tolerance)
        add('left-edge', nodes, {values});
    }
    for (const group of spec.centers || []) {
      for (const parent of select(group.parent)) {
        for (const nodes of lines(select(group.children, parent), group.wrap)) {
        if (nodes.length < 2) continue;
        counts.alignments++;
        const values = nodes.map(node => {const value = rect(node); return value.top + value.height / 2;});
        if (Math.max(...values) - Math.min(...values) > tolerance)
          add('inline-center', nodes, {parent: describe(parent), values});
        }
      }
    }
    // A text Range gives the browser's actual font box. Canvas metrics locate
    // its baseline; unlike element centres this catches mismatched font sizes.
    const canvas = document.createElement('canvas').getContext('2d');
    const baseline = node => {
      const style = getComputedStyle(node);
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const metrics = canvas.measureText('Hg');
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) if (text.textContent.trim()) break;
      if (text) {
        const range = document.createRange(); range.selectNodeContents(text);
        return range.getBoundingClientRect().top + metrics.fontBoundingBoxAscent;
      }
      const bounds = rect(node);
      return bounds.top + bounds.height / 2 +
        (metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2;
    };
    for (const group of spec.baselines || []) {
      for (const parent of select(group.parent)) {
        for (const nodes of lines(select(group.children, parent), group.wrap)) {
        if (nodes.length < 2) continue;
        const values = nodes.map(baseline); counts.alignments++;
        if (Math.max(...values) - Math.min(...values) > tolerance)
          add('text-baseline', nodes, {parent: describe(parent), values});
        }
      }
    }
    for (const selector of spec.helpRows || []) {
      for (const parent of select(selector)) {
        const help = select('[data-copy-help],[data-maintenance-info]', parent);
        const labels = [parent, ...select('label,h2,h3,strong', parent)].filter(node => node.matches('label,h2,h3,strong') && !node.closest('.copy-help-popup,.maintenance-info-body'));
        if (!help.length || !labels.length) continue;
        for (const node of help) {
          let label = rect(labels[0]);
          if (labels[0].contains(node)) {
            const text = [...labels[0].childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
            if (text) {const range = document.createRange(); range.selectNodeContents(text); label = range.getBoundingClientRect();}
          }
          const value = rect(node);
          if (value.left < label.right - tolerance || value.top > label.bottom + tolerance || value.bottom < label.top - tolerance)
            add('help-position', [labels[0], node], {label: {left: label.left, right: label.right, top: label.top, bottom: label.bottom},
              help: {left: value.left, right: value.right, top: value.top, bottom: value.bottom}});
        }
      }
    }
    for (const selector of spec.helpContexts || []) {
      for (const node of select(selector))
        if (!node.closest('.field-caption,.copy-caption,h2,h3,p,li,summary')) add('orphan-help', [node], {});
    }
    // Drawer explanations need a real label sibling, not just a containing
    // paragraph, action group or list item. Check the rendered label boxes.
    for (const group of spec.labelledHelp || []) {
      for (const button of select(group.buttons)) {
        const row = button.closest('.copy-help,details.ui-info')?.parentElement;
        const label = row?.matches(group.rows) ? select(group.labels, row)[0] : null;
        if (!label || label.contains(button)) { add('orphan-help', [button], {}); continue; }
        const caption = rect(label), help = rect(button);
        counts.alignments++;
        if (help.left < caption.right - tolerance ||
            Math.abs(help.top + help.height / 2 - caption.top - caption.height / 2) > tolerance)
          add('labelled-help-position', [label, button], {
            label: {left: caption.left, right: caption.right, top: caption.top, height: caption.height},
            help: {left: help.left, right: help.right, top: help.top, height: help.height}});
      }
    }
    for (const group of spec.siblingSpacing || []) {
      for (const parent of select(group.parent)) {
        const nodes = select(group.children || ':scope > *', parent);
        for (let index = 1; index < nodes.length; index++) {
          const gap = rect(nodes[index]).top - rect(nodes[index - 1]).bottom;
          counts.rows++;
          if (Math.abs(gap - group.gap) > tolerance)
            add('sibling-spacing', [nodes[index - 1], nodes[index]], {parent: describe(parent), gap, expected: group.gap});
        }
      }
    }
    for (const selector of spec.closedDisclosures || []) {
      for (const node of select(selector)) {
        const summary = node.querySelector(':scope > summary');
        if (node.open || !rendered(summary)) continue;
        if (Math.abs(rect(node).height - rect(summary).height) > tolerance)
          add('closed-disclosure-space', [node, summary], {height: rect(node).height, summaryHeight: rect(summary).height});
      }
    }
    for (const selector of spec.disclosureRows || []) {
      for (const summary of select(selector)) {
        const walker = document.createTreeWalker(summary, NodeFilter.SHOW_TEXT);
        const boxes = [];
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
          if (!text.textContent.trim() || !rendered(text.parentElement)) continue;
          const range = document.createRange(); range.selectNodeContents(text);
          boxes.push(...[...range.getClientRects()].filter(box => box.width > 0 && box.height > 0));
        }
        if (!boxes.length) { add('disclosure-label', [summary], {}); continue; }
        const row = rect(summary), top = Math.min(...boxes.map(box => box.top)), bottom = Math.max(...boxes.map(box => box.bottom));
        counts.alignments++;
        if (Math.abs((top + bottom) / 2 - row.top - row.height / 2) > tolerance)
          add('disclosure-text-center', [summary], {textTop: top, textBottom: bottom, rowTop: row.top, rowHeight: row.height});
        const marker = getComputedStyle(summary, '::before'), expected = summary.parentElement.open ? '▾' : '▸';
        if (marker.content.replace(/^["']|["']$/g, '') !== expected || marker.display === 'none' || marker.visibility === 'hidden')
          add('disclosure-marker', [summary], {content: marker.content, expected});
      }
    }
    for (const group of spec.disclosureAfterSpacing || []) {
      for (const details of select(group.details)) {
        const next = select(group.nextBlocks).find(node => details.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (!next) { add('missing-disclosure-successor', [details], {}); continue; }
        const gap = rect(next).top - rect(details).bottom;
        counts.rows++;
        if (Math.abs(gap - group.gap) > tolerance)
          add('disclosure-after-spacing', [details, next], {gap, expected: group.gap});
      }
    }
    for (const group of spec.buttonRows || []) {
      for (const parent of select(group.parent)) {
        const nodes = select(group.children || 'button', parent);
        if (nodes.length < 2) continue;
        counts.rows++;
        const heights = nodes.map(node => rect(node).height);
        if (Math.max(...heights) - Math.min(...heights) > tolerance)
          add('row-control-height', nodes, {parent: describe(parent), heights});
      }
    }
    // These checks are opt-in. Existing specifications keep their original
    // measurements and results until they describe these relationships.
    for (const group of spec.sameRowControls || []) {
      for (const parent of select(group.parent)) {
        const controls = select(group.children || 'input,select,button', parent);
        // A long caption can move its control by more than a control's own
        // height. Group the field wrappers, not the displaced control boxes.
        const fields = new Map(controls.map(node => {
          let field = node;
          while (field.parentElement && field.parentElement !== parent) field = field.parentElement;
          return [node, field];
        }));
        for (const row of lines([...new Set(fields.values())], group.wrap !== false)) {
          const nodes = controls.filter(node => row.includes(fields.get(node)));
          if (nodes.length < 2) continue;
          counts.alignments++;
          const values = nodes.map(node => rect(node).top);
          if (Math.max(...values) - Math.min(...values) > tolerance)
            add('same-row-controls', nodes, {parent: describe(parent), values, maximum: tolerance});
        }
      }
    }
    const textFragments = node => {
      const boxes = [], walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) {
        if (!text.textContent.trim() || !rendered(text.parentElement)) continue;
        const range = document.createRange(); range.selectNodeContents(text);
        for (const box of range.getClientRects()) if (box.width && box.height)
          boxes.push({left: box.left, right: box.right, top: box.top, bottom: box.bottom});
      }
      return boxes;
    };
    for (const selector of spec.unbrokenValues || []) {
      for (const node of select(selector)) {
        // Units may use a smaller font on the same baseline. Intersecting
        // font boxes distinguish that from a number or unit on another line.
        const rows = [];
        for (const box of textFragments(node)) {
          const row = rows.find(other => Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > tolerance);
          if (row) {row.top = Math.max(row.top, box.top); row.bottom = Math.min(row.bottom, box.bottom);}
          else rows.push({top: box.top, bottom: box.bottom});
        }
        if (rows.length > 1) add('value-word-wrap', [node], {lines: rows, text: node.textContent});
      }
    }
    for (const group of spec.tokenGap || []) {
      for (const parent of select(group.parent)) {
        const left = select(group.left, parent)[0], right = select(group.right, parent)[0];
        if (!left || !right) continue;
        const a = textFragments(left), b = textFragments(right);
        if (!a.length || !b.length) continue;
        const gap = Math.min(...b.map(box => box.left)) - Math.max(...a.map(box => box.right));
        const minimum = group.minimum ?? 6;
        if (gap < minimum - .01) add('token-gap', [left, right], {parent: describe(parent), gap, minimum});
      }
    }
    for (const group of spec.siblingGap || []) {
      const combined = [];
      for (const parent of select(group.parent)) {
        const nodes = select(group.children || ':scope > *', parent);
        const bounds = node => {
          const fragments = group.textBounds && node.matches(group.textBounds) ? textFragments(node) : [];
          return fragments.length ? {top: Math.min(...fragments.map(box => box.top)),
            bottom: Math.max(...fragments.map(box => box.bottom))} : rect(node);
        };
        const rows = (group.wrap === false ? nodes.map(node => [node]) : lines(nodes, true)).map(row => ({nodes: row,
          top: Math.min(...row.map(node => bounds(node).top)),
          bottom: Math.max(...row.map(node => bounds(node).bottom))})).sort((a, b) => a.top - b.top);
        const gaps = rows.slice(1).map((row, index) => ({nodes: [...rows[index].nodes, ...row.nodes],
          gap: row.top - rows[index].bottom}));
        const check = values => {
          if (values.length < 2) return;
          counts.alignments++;
          const sizes = values.map(value => value.gap);
          if (Math.max(...sizes) - Math.min(...sizes) > tolerance)
            add('sibling-gap', [...new Set(values.flatMap(value => value.nodes))],
              {parent: group.parent, values: sizes, maximum: tolerance});
        };
        if (group.together) combined.push(...gaps);
        else check(gaps);
      }
      if (group.together && combined.length > 1) {
        counts.alignments++;
        const values = combined.map(value => value.gap);
        if (Math.max(...values) - Math.min(...values) > tolerance)
          add('sibling-gap', [...new Set(combined.flatMap(value => value.nodes))],
            {parent: group.parent, values, maximum: tolerance});
      }
    }
    for (const selector of spec.repeatedPadding || []) {
      const nodes = select(selector);
      if (nodes.length < 2) continue;
      const values = nodes.map(node => {const style = getComputedStyle(node); return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];});
      if (values.some(value => value.join() !== values[0].join())) add('repeated-padding', nodes, {values});
    }
    for (const selector of spec.repeatedGaps || []) {
      const nodes = select(selector);
      if (nodes.length < 2) continue;
      const values = nodes.map(node => {const style = getComputedStyle(node); return [style.rowGap, style.columnGap];});
      if (values.some(value => value.join() !== values[0].join())) add('repeated-gap', nodes, {values});
    }
    for (const selector of spec.repeatedRowHeights || []) {
      const nodes = select(selector);
      if (nodes.length < 2) continue;
      const values = nodes.map(node => rect(node).height);
      if (Math.max(...values) - Math.min(...values) > tolerance) add('row-height', nodes, {values});
    }
    for (const group of spec.tableColumns || []) {
      const rows = select(group.rows).map(row => select(group.cells || ':scope > *', row));
      if (rows.length < 2) continue;
      for (let column = 0; column < rows[0].length; column++) {
        const nodes = rows.map(row => row[column]).filter(Boolean);
        if (nodes.length < 2) continue;
        const values = nodes.map(node => rect(node).left);
        // Stacked cards do not promise desktop column lines.
        if (nodes.some(node => rect(node).width < 1)) continue;
        counts.alignments++;
        if (Math.max(...values) - Math.min(...values) > tolerance) add('table-column', nodes, {column, values});
      }
    }
    for (const selector of spec.numericCells || []) {
      for (const node of select(selector)) {
        const style = getComputedStyle(node);
        if (!['right', 'end'].includes(style.textAlign))
          add('numeric-alignment', [node], {textAlign: style.textAlign});
      }
    }
    for (const selector of spec.unbrokenTitles || []) {
      for (const node of select(selector)) {
        const range = document.createRange(); range.selectNodeContents(node);
        const tops = [];
        for (const fragment of range.getClientRects())
          if (fragment.width && fragment.height && !tops.some(top => Math.abs(fragment.top - top) <= tolerance)) tops.push(fragment.top);
        if (tops.length > 1) add('title-word-wrap', [node], {lineTops: tops, text: node.textContent});
      }
    }
    for (const root of roots) {
      for (const node of select('p,span,label,small,strong,button,input,select,summary', root)) {
        if (node.closest('[aria-hidden=true],.copy-help-popup,.maintenance-info-body') ||
            ![...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())) continue;
        const fontSize = parseFloat(getComputedStyle(node).fontSize);
        if (fontSize === 0 && node.matches('[data-maintenance-info]') && parseFloat(getComputedStyle(node, '::before').fontSize) >= 11) continue;
        if (fontSize < 11) add('minimum-type', [node], {fontSize, minimum: 11});
      }
      for (const node of select(spec.containment || 'input,select,button,h1,h2,h3,.field-caption,.server-id', root)) {
        if (node.closest('.copy-help-popup,.maintenance-info-body,.account-popover')) continue;
        const value = rect(node);
        let scrolling = false;
        for (let parent = node.parentElement; parent && parent !== root; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (['auto', 'scroll'].includes(style.overflowX)) {scrolling = true; break;}
          if (['hidden', 'clip'].includes(style.overflowX)) {
            const boundary = rect(parent);
            if (value.left < boundary.left - tolerance || value.right > boundary.right + tolerance)
              add('container-clipping', [node, parent], {left: value.left, right: value.right,
                boundaryLeft: boundary.left, boundaryRight: boundary.right});
          }
        }
        if (!scrolling && (value.left < -tolerance || value.right > width + tolerance))
          add('horizontal-clipping', [node], {left: value.left, right: value.right, width});
        counts.containment++;
      }
    }
    // Explicit scrolling surfaces clip their own descendants. Measure the
    // painted intersection for overlap; their full controls and scrollability
    // remain subject to the height, containment and scroll-panel checks above.
    const clippedPanels=(spec.clippedScrollPanels||[]).flatMap(selector=>select(selector));
    for(const panel of clippedPanels)if(!['auto','scroll'].includes(getComputedStyle(panel).overflowY))
      add('invalid-scroll-clip',[panel],{overflowY:getComputedStyle(panel).overflowY});
    const paintedRect=node=>{
      const value=rect(node),result={left:value.left,right:value.right,top:value.top,bottom:value.bottom};
      for(const panel of clippedPanels)if(panel.contains(node)){
        const bounds=rect(panel);result.left=Math.max(result.left,bounds.left);result.right=Math.min(result.right,bounds.right);
        result.top=Math.max(result.top,bounds.top);result.bottom=Math.min(result.bottom,bounds.bottom);
      }
      return result;
    };
    const clickable = controls.filter(node => inView(node) && !node.closest('.copy-help-popup,.maintenance-info-body'));
    const reachableBehindReservedLayer = (layer, node) => (spec.bottomReserve || []).some(group => {
      if (!layer.matches(group.controls) && !layer.closest(group.controls)) return false;
      const surface = layer.matches(group.controls) ? layer : layer.closest(group.controls);
      const content = node.closest(group.content);
      if (!content || getComputedStyle(surface).position !== 'fixed' || getComputedStyle(surface).bottom === 'auto') return false;
      for (let parent = node; parent && parent !== content; parent = parent.parentElement)
        if (getComputedStyle(parent).position === 'fixed') return false;
      const padding = parseFloat(getComputedStyle(content).paddingBottom);
      const required = innerHeight - rect(surface).top;
      const maximumScroll = document.documentElement.scrollHeight - innerHeight;
      // A normal scrolling row can pass behind the persistent bottom layer.
      // It must be reachable above that layer at the end of the document.
      return padding >= required - tolerance && rect(node).bottom + scrollY - maximumScroll <= rect(surface).top + tolerance;
    });
    for (let index = 0; index < clickable.length; index++) {
      const left = clickable[index], a = paintedRect(left);
      for (const right of clickable.slice(index + 1)) {
        if (left.contains(right) || right.contains(left) || left.closest('.account-popover') !== right.closest('.account-popover')) continue;
        if (reachableBehindReservedLayer(left, right) || reachableBehindReservedLayer(right, left)) continue;
        const b = paintedRect(right);
        const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapWidth > tolerance && overlapHeight > tolerance)
          add('overlap', [left, right], {width: overlapWidth, height: overlapHeight});
      }
    }
    for (const selector of spec.popovers || []) {
      for (const node of select(selector)) {
        const value = rect(node);
        if (value.left < -tolerance || value.right > width + tolerance || value.top < -tolerance || value.bottom > innerHeight + tolerance)
          add('popover-clipping', [node], {left: value.left, right: value.right, top: value.top, bottom: value.bottom, width, height: innerHeight});
      }
    }
    for (const selector of spec.scrollPanels || []) {
      for (const node of select(selector)) {
        const bounds = rect(node), style = getComputedStyle(node);
        if (bounds.top < -tolerance || bounds.bottom > innerHeight + tolerance)
          add('panel-clipping', [node], {top: bounds.top, bottom: bounds.bottom, height: innerHeight});
        if (node.scrollHeight > node.clientHeight + tolerance &&
            !['auto', 'scroll'].includes(style.overflowY))
          add('unreachable-panel-content', [node], {scrollHeight: node.scrollHeight,
            clientHeight: node.clientHeight, overflowY: style.overflowY});
      }
    }
    for (const group of spec.bottomReserve || []) {
      const content = select(group.content)[0], controls = select(group.controls).filter(node => {
        const style = getComputedStyle(node);
        return style.position === 'fixed' && style.bottom !== 'auto';
      });
      if (!content || !controls.length) continue;
      const style = getComputedStyle(content);
      const required = Math.max(...controls.map(node => innerHeight - rect(node).top));
      const reserved = parseFloat(style.paddingBottom);
      if (reserved < required - tolerance) add('bottom-reserve', [content, ...controls], {reserved, required});
    }
    return {width, height: innerHeight, devicePixelRatio, counts, pass: failures.length === 0, failures};
  }, specification);
}

export async function scanGeometry(page, specification, {widths = layoutWidths, heights = layoutHeights, zoom = 1} = {}) {
  const results = [];
  for (const height of heights) {
    for (const width of widths) {
      await page.setViewportSize({width: Math.floor(width / zoom), height: Math.floor(height / zoom)});
      await page.evaluate(async () => {
        for (const animation of document.getAnimations()) {
          if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
        }
        await new Promise(resolve => requestAnimationFrame(resolve));
      });
      results.push({physicalWidth: width, physicalHeight: height, zoom, ...await inspectGeometry(page, specification)});
    }
  }
  return results;
}
