// Disposable loopback Portal and fake node; no SSH, GPU or private payloads.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {inspectOperationalGeometry} from './operational-geometry.mjs';
const dir=await mkdtemp(join(tmpdir(),'project-lifecycle-ui-')),password='Only-Fixture-Project-2026!',hash='a'.repeat(64),calls=[],errors=[];
let server,service,browser,owner;const projects=new Map(),retirements=new Map(),machine=MACHINES[0].id,other=MACHINES[1].id;
const key=(m,u,p)=>JSON.stringify([m,u,p]),statusPath=join(dir,'status'),bootstrap=join(dir,'bootstrap');
const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));const origin='http://127.0.0.1:'+port;
try{
 await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
 await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:[],gpuq:{connected:true,observeOnly:false,schedulableIndices:[0],jobs:[]}}))}));
 const bridge=async(m,operation,args)=>{
  calls.push({machine:m,operation,args:structuredClone(args)});const identity=key(m,args.userId,args.project),row=projects.get(identity);
  if(operation==='projects.list')return {projects:[...projects].filter(([k])=>{const [mm,uu]=JSON.parse(k);return mm===m&&uu===args.userId;}).map(([,v])=>structuredClone(v))};
  if(operation==='projects.status'){assert.ok(row,'project must exist');return structuredClone(row);}
  if(['projects.archive','projects.unarchive'].includes(operation)){assert.equal(row.lifecycle.revision,args.revision);row.lifecycle={...row.lifecycle,state:operation==='projects.archive'?'ARCHIVED':'ACTIVE',revision:args.revision+1};return structuredClone(row.lifecycle);}
  if(operation==='projects.retire.plan')return {protocol:'project-lifecycle-v1',project:args.project,state:'ELIGIBLE',lifecycle:row.lifecycle,manifestSha256:hash,entries:15,bytes:4096,blockers:[]};
  if(operation==='projects.retire'){assert.equal(row.lifecycle.revision,args.revision);assert.equal(args.manifestSha256,hash);retirements.set(args.key,{protocol:'project-lifecycle-v1',project:args.project,state:'RETIRED',revision:args.revision+1,preservesBytes:true});projects.delete(identity);throw Error('Synthetic lost final receipt');}
  if(operation==='projects.retire.status'){assert.ok(retirements.has(args.key));return retirements.get(args.key);}
  throw Error('Unexpected fixture operation '+operation);
 };
 ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath,origin,secure:false,bridge}));clearInterval(service.executionTimer);
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 const admin=await service.login('admin',password);owner=(await service.invoke(admin.token,'users.create',{username:'member',password})).result.id;const member=await service.login('member',password);
 await service.invoke(admin.token,'policy.save',{userId:owner,policyVersion:0,total:2,limits:{[machine]:1,[other]:1}});
 for(const [m,p,lifecycle] of [[machine,'alpha','ACTIVE'],[machine,'old','ARCHIVED'],[machine,'unused','ACTIVE'],[other,'beta','ACTIVE']])projects.set(key(m,owner,p),{project:p,state:'READY',environmentMode:'oci',releases:[{release:hash,state:'READY'}],latestReadyRelease:hash,lifecycle:{protocol:'project-lifecycle-v1',state:lifecycle,revision:lifecycle==='ARCHIVED'?1:0}});
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>errors.push(e.message));await page.context().route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin);await page.locator('#login-form [name=username]').fill('member');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
 const response=op=>page.waitForResponse(r=>r.url()===origin+'/api/call'&&r.request().postDataJSON()?.operation===op);
 async function act(op,fn){const pending=response(op);await fn();const result=await pending;assert.equal(result.status(),200,await result.text());await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]')?.disabled);}
 await act('projects.list',()=>page.locator('[name=workspace-machine]').selectOption(machine));await act('projects.status',()=>page.locator('[name=workspace-project]').selectOption('alpha'));
 await page.locator('#project-management>summary').click();assert.equal(await page.locator('[name=workspace-project] option[value=old]').count(),0);
 await page.locator('[data-display-name]').fill('中文研究项目');await act('projects.label.set',()=>page.locator('[data-label-form] [type=submit]').click());assert.match(await page.locator('[name=workspace-project] option[value=alpha]').textContent(),/中文研究项目/);
 await act('projects.label.get',()=>page.getByRole('button',{name:'读取最新名称',exact:true}).click());assert.equal(await page.locator('[data-display-name]').inputValue(),'中文研究项目');
 await service.invoke(member.token,'projects.label.set',{machine,project:'alpha',displayName:'另一客户端的新名称',revision:1});
 await act('projects.list',()=>page.locator('#projects-refresh').click());await page.locator('[data-display-name]').fill('我的未保存修改');const conflict=response('projects.label.set');await page.locator('[data-label-form] [type=submit]').click();assert.equal((await conflict).status(),409);await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]')?.disabled);
 await act('projects.label.get',()=>page.getByRole('button',{name:'读取最新名称',exact:true}).click());assert.equal(await page.locator('[data-display-name]').inputValue(),'另一客户端的新名称');
 await page.locator('[data-group-name]').fill('机器人研究');await act('projects.group.set',()=>page.locator('[data-group-form] [type=submit]').click());
 await act('projects.catalog',()=>page.locator('[data-project-catalog]').click());assert.match(await page.locator('[data-catalog-output]').textContent(),/机器人研究/);assert.equal(await page.locator('[name=workspace-project] optgroup').count(),1);
 await act('projects.group.set',()=>page.locator('[data-group-remove]').click());assert.equal(await page.locator('[name=workspace-project] optgroup').count(),0);
 page.once('dialog',d=>d.accept());await act('projects.archive',()=>page.locator('[data-project-archive]').click());assert.equal(await page.locator('#terminal-open').isDisabled(),true);assert.equal(await page.locator('#project-publish').isDisabled(),true);
 page.once('dialog',d=>d.accept());await act('projects.unarchive',()=>page.locator('[data-project-archive]').click());assert.equal(await page.locator('#terminal-open').isDisabled(),false);
 await page.locator('[data-include-archived]').check();assert.equal(await page.locator('[name=workspace-project] option[value=old]').count(),1);
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:1000});await page.locator('#project-management').scrollIntoViewIfNeeded();
  const geometry=await inspectOperationalGeometry(page,{roots:['#project-management'],controls:'button,input,select,summary',largeTargets:['#project-management button','#project-management summary','#project-management input:not([type=checkbox])','#project-management select'],textContainment:['[data-project-identity]','[data-retire-receipt]']});assert.deepEqual(geometry.failures,[],JSON.stringify({width,failures:geometry.failures}));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.UI_SCREENSHOTS){await mkdir(process.env.UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:join(process.env.UI_SCREENSHOTS,`project-management-${width}.png`),fullPage:true});}
 }
 await act('projects.status',()=>page.locator('[name=workspace-project]').selectOption('unused'));await act('projects.retire.plan',()=>page.locator('[data-retire-plan]').click());assert.equal(await page.locator('[data-retire-confirm]').isDisabled(),false);
 page.once('dialog',d=>d.accept());const lost=response('projects.retire');await page.locator('[data-retire-confirm]').click();assert.equal((await lost).status(),400);await page.waitForFunction(()=>document.querySelector('[data-management-status]')?.textContent.includes('未确认'));
 const intent=calls.find(c=>c.operation==='projects.retire').args;assert.equal(await page.locator('[data-retire-confirm]').isDisabled(),true);assert.match(await page.locator('[data-retire-receipt]').textContent(),new RegExp(intent.key));
 await act('projects.retire.status',()=>page.locator('[data-retire-query]').click());assert.equal(calls.filter(c=>c.operation==='projects.retire').length,1);assert.equal(calls.at(-1).args.key,intent.key);assert.match(await page.locator('[data-management-status]').textContent(),/已确认/);
 await act('projects.list',()=>page.locator('#projects-refresh').click());assert.equal(await page.locator('[name=workspace-project] option[value=unused]').count(),0);
 assert.deepEqual(errors,[]);assert.equal(service.store.jobs.length,0);console.log(JSON.stringify({passed:true,checks:['name CAS','logical group/detach','archive/unarchive','catalog/filter','1440/390/320 geometry','lost receipt original-key query','no job dispatch']}));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
