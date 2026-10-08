import assert from 'node:assert/strict';
import {join} from 'node:path';

// Runs against the authenticated local fixture in dataset-upload-ui-smoke.
// No archive requests are issued before the unpublished transport is integrated.
export async function testArchiveUpload(page,screenshots){
  const input=page.locator('[name=dataset-directory]');
  assert.equal(await page.locator('.dataset-archive-intake').count(),0,'Absent archive capability leaves the original uploader intact');
  assert.equal(await input.getAttribute('webkitdirectory'),'');
  assert.equal(await input.getAttribute('multiple'),'');
  if(!await page.locator('#dataset-add-dialog').evaluate(node=>node.open))await page.locator('#warehouse-page-actions [data-v3-upload]').click();
  await page.locator('[data-v3-folder]').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-v3-files]').isVisible(),true);
  await page.screenshot({path:join(screenshots,'archive-capability-off-390.png'),fullPage:true});
  const writesBefore=await page.evaluate(()=>calls.filter(row=>row.operation.startsWith('datasets.upload.')&&row.operation!=='datasets.upload.routes').length);
  await page.evaluate(()=>{store.data.datasetUploadAdmission={protocol:1,available:true,targetMachine:'gpu-1',archive:{protocol:1,formats:['zip','tar','tar.gz','tgz'],maxBytes:100}};renderDatasets();});
  await page.locator('[data-archive-drop]').waitFor({state:'visible'});
  assert.equal(await input.getAttribute('webkitdirectory'),null);
  assert.equal(await input.getAttribute('multiple'),null);
  assert.equal(await input.getAttribute('accept'),'.zip,.tar,.tar.gz,.tgz');
  assert.equal(await page.locator('[data-dataset-source=directory]').textContent(),'电脑上传');
  assert.equal(await page.locator('[data-dataset-source=link]').isVisible(),true,'Link import remains accessible');
  assert.equal(await page.locator('[data-dataset-source=workspace]').isVisible(),true,'Server workspace remains accessible');
  assert.equal(await page.locator('#v3-relay-options:visible').count(),0);
  assert.equal(await page.locator('[data-archive-start]').isDisabled(),true);
  await input.setInputFiles({name:'unsupported.txt',mimeType:'text/plain',buffer:Buffer.from('abc')});
  assert.equal(await page.locator('[data-archive-status]').textContent(),'请选择支持的压缩包');
  await input.setInputFiles({name:'large.zip',mimeType:'application/zip',buffer:Buffer.alloc(101)});
  assert.equal(await page.locator('[data-archive-status]').textContent(),'压缩包过大');
  await page.evaluate(()=>{
    const input=document.querySelector('[name=dataset-directory]'),dt=new DataTransfer();
    dt.items.add(new File(['x'],'one.zip'));dt.items.add(new File(['y'],'two.zip'));
    input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  });
  assert.equal(await page.locator('[data-archive-status]').textContent(),'请选择一个压缩包');
  await page.evaluate(()=>{
    const event=new Event('drop',{bubbles:true,cancelable:true});
    Object.defineProperty(event,'dataTransfer',{value:{items:[{webkitGetAsEntry:()=>({isDirectory:true})}],files:[]}});
    document.querySelector('[data-archive-drop]').dispatchEvent(event);
  });
  assert.equal(await page.locator('[data-archive-status]').textContent(),'请选择压缩包，不接受文件夹');
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:900});
    await input.setInputFiles({name:'训练数据.tar.gz',mimeType:'application/gzip',buffer:Buffer.alloc(80)});
    assert.equal(await page.locator('[data-archive-filename]').textContent(),'训练数据.tar.gz');
    assert.equal(await page.locator('[name=dataset-archive-name]').inputValue(),'训练数据');
    assert.equal(await page.locator('[data-archive-size]').textContent(),'80 B');
    await page.locator('[name=dataset-archive-name]').fill('训练集');
    assert.equal(await page.locator('#v3-upload-display').inputValue(),'训练集');
    assert.equal(await page.locator('[data-archive-route]').getAttribute('aria-label'),'你的电脑 · 校内直连 · gpu-1');
    assert.equal(await page.locator('[data-archive-route].ok').count(),0,'The intended route does not pretend that a probe succeeded');
    assert.equal(await page.locator('#dataset-upload-start').isDisabled(),true);
    assert.equal(await page.locator('[data-archive-start]').isDisabled(),true);
    const geometry=await page.locator('.dataset-archive-intake').evaluate(root=>({overflow:document.documentElement.scrollWidth>innerWidth+1,controls:[...root.querySelectorAll('button,input')].filter(node=>node.getClientRects().length).map(node=>({name:node.name||node.textContent,height:node.getBoundingClientRect().height})),help:[...root.closest('dialog').querySelectorAll('.ui-info')].filter(node=>node.getClientRects().length).length}));
    assert.equal(geometry.overflow,false);
    assert.ok(geometry.controls.every(control=>control.height>=48),'All visible archive touch controls retain 48px targets: '+JSON.stringify(geometry.controls));
    assert.ok(geometry.help<=1,'No explanatory paragraphs or duplicate help in the archive intake');
    await page.screenshot({path:join(screenshots,`archive-selected-${width}.png`),fullPage:true});
  }
  await page.evaluate(()=>document.querySelector('#dataset-upload-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(await page.locator('[data-archive-status]').textContent(),'上传暂不可用');
  assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation.startsWith('datasets.upload.')&&row.operation!=='datasets.upload.routes').length),writesBefore,'UI-only archive mode cannot start the legacy ordinary-file publisher');
  await page.evaluate(()=>{delete store.data.datasetUploadAdmission.targetMachine;renderDatasets();});
  assert.equal(await page.locator('[data-archive-route]').getAttribute('aria-label'),'你的电脑 · 校内直连 · 待确认','Never guess the warehouse from the training selector');
  assert.equal(await input.evaluate(node=>node.files.length),0,'Changing the target clears the selected file');
  await page.evaluate(()=>{store.data.datasetUploadAdmission.archive={protocol:0,formats:['zip']};renderDatasets();});
  assert.equal(await page.locator('.dataset-archive-intake').count(),0);
  assert.equal(await input.getAttribute('webkitdirectory'),'');
  assert.equal(await input.getAttribute('multiple'),'');
  assert.equal(await page.locator('[data-dataset-source=directory]').textContent(),'电脑目录');
  await page.locator('[data-v3-folder]').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-v3-files]').isVisible(),true);
  await page.screenshot({path:join(screenshots,'archive-capability-off-restored-390.png'),fullPage:true});
  await page.evaluate(()=>{store.data.datasetUploadAdmission.archive={protocol:1,formats:['zip'],maxBytes:null};renderDatasets();});
  await input.setInputFiles({name:'private.zip',mimeType:'application/zip',buffer:Buffer.from('x')});
  await page.evaluate(()=>{store.authGeneration++;store.principal={userId:'old-user',role:'member'};store.listeners.forEach(listener=>listener());renderDatasets();});
  assert.equal(await input.evaluate(node=>node.files.length),0,'A new account cannot inherit the selected archive');
  assert.doesNotMatch(await page.locator('.dataset-archive-intake').textContent(),/private.zip/);
  console.log('ARCHIVE UPLOAD UI PASS: strict draft capability; single archive validation; 48px desktop/mobile controls; link/workspace preserved; disabled transport; target/account fences; original folder UI restored.');
}
