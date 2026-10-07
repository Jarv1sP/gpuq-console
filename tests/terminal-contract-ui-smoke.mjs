// Real loopback Portal authentication + the actual xterm UI. The synthetic
// node implements the documented session contract; no shell/GPU is started.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';

export async function terminalContractSmoke(){
  const folder=await mkdtemp(join(tmpdir(),'gpuq-terminal-contract-'));
  const shots=join(process.env.UI_SCREENSHOTS||'/tmp/gpuq-terminal-contract','terminal-contract');
  const password='Terminal-Contract-Fixture-Only-2026!',projects=[
    {project:'python-lab',environmentMode:'shared',state:'DRAFT',releases:[]},
    {project:'container-lab',environmentMode:'oci',state:'DRAFT',releases:[]}
  ];
  const sessions=new Map(),calls=[],requests=[],errors=[],outside=[],tokens=[];
  let heldExchange=null;
  let server,service,browser,dropInput=false,rateId=null,rateRemaining=0,closeUnconfirmed=false;
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port,origin='http://127.0.0.1:'+port;await new Promise(resolve=>reservation.close(resolve));
  try{
    const machine=MACHINES[0].id;
    await mkdir(shots,{recursive:true});
    const bootstrap=join(folder,'bootstrap'),statusPath=join(folder,'status');
    await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
    await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(row=>({id:row.id,reachable:true,gpus:Array.from({length:row.cards},(_,index)=>({index,model:row.model,memoryTotalMiB:24576,memoryUsedMiB:0,processesAvailable:true,processes:[]})),gpuq:{connected:true,observeOnly:false,schedulableIndices:[0],jobs:[]}}))}));
    const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
    function owned(node,args){
      const session=sessions.get(args.id);if(!session||session.userId!==args.userId||session.machine!==node||session.project!==args.project||session.hostAdmin!==args.hostAdmin)fail('会话不属于当前账号或上下文。',403);
      return session;
    }
    function writer(node,args){const session=owned(node,args);if(session.revoked||session.clientId!==args.clientId||session.writerToken!==args.writerToken||session.detached||session.leaseExpiresAt<=Date.now())fail('Terminal writer lease expired or was taken over; reconnect explicitly');return session;}
    const bridge=async(node,operation,args)=>{
      calls.push({machine:node,operation,args:structuredClone(args),at:Date.now()});
      if(operation==='projects.list')return {projects:structuredClone(projects)};
      if(operation==='projects.status')return structuredClone(projects.find(project=>project.project===args.project));
      if(operation==='datasets.list')return {datasets:[]};
      if(operation==='datasets.capacity')return {filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:10*1024**3,usableBytes:502*1024**3,guarded:true};
      if(operation==='terminal.open'){
        let value;
        if(args.mode==='new'){
          assert.equal(args.id,undefined);assert.equal(args.writerToken,undefined);
          if(projects.find(row=>row.project===args.project)?.environmentMode==='oci'&&[...sessions.values()].some(row=>row.userId===args.userId&&row.machine===node&&row.project===args.project&&!row.ended))fail('此项目已有开发终端，请用原会话重连。',409);
          value={id:args.key,machine:node,userId:args.userId,project:args.project,hostAdmin:args.hostAdmin,output:'Local fixture. No shell or GPU is started.\r\n',inputs:[],pending:0,maxPending:0};sessions.set(value.id,value);
        }else{
          value=owned(node,args);if(value.ended)fail('Terminal has ended; create a new session');
          if(!value.detached&&value.leaseExpiresAt>Date.now()&&value.clientId!==args.clientId&&!args.takeover)fail('Terminal has another active writer; detach it or explicitly take over');
        }
        value.clientId=args.clientId;value.writerToken=randomUUID();tokens.push(value.writerToken);value.detached=false;value.revoked=false;value.leaseExpiresAt=Date.now()+30000;
        return {id:value.id,hostAdmin:value.hostAdmin,clientId:value.clientId,writerToken:value.writerToken,leaseExpiresAt:value.leaseExpiresAt/1000,mode:args.mode};
      }
      if(operation==='terminal.exchange'){
        const value=writer(node,args);value.pending++;value.maxPending=Math.max(value.maxPending,value.pending);
        try{
          await new Promise(resolve=>setTimeout(resolve,15));
          // Hold a validated poll so revocation occurs during its async wait.
          const held=heldExchange?.id===value.id&&!heldExchange.release?heldExchange:null;
          if(held){held.inputEmpty=!args.input;await new Promise(resolve=>{held.release=resolve;});}
          const input=Buffer.from(args.input||'','base64').toString();if(input){value.inputs.push(input);value.output+='accepted: '+input+'\r\n';}
          const now=Date.now();
          // A delayed mock response must not revive an expired/revoked writer
          // or extend a lease that now belongs to another attachment.
          if(sessions.get(args.id)===value&&!value.revoked&&!value.detached&&
              value.clientId===args.clientId&&value.writerToken===args.writerToken&&
              value.leaseExpiresAt>now&&value.leaseExpiresAt-now<15000)value.leaseExpiresAt=now+30000;
          const data=Buffer.from(value.output);return {offset:data.length,data:data.subarray(args.offset||0).toString('base64'),exited:value.ended===true,exitCode:value.ended?value.exitCode:null};
        }finally{value.pending--;if(heldExchange?.id===value.id&&heldExchange.release)heldExchange.completed=true;}
      }
      if(operation==='terminal.detach'){const value=writer(node,args);value.detached=true;value.leaseExpiresAt=0;return {detached:true,id:value.id};}
      if(operation==='terminal.status'){const value=owned(node,args);assert.equal(args.writerToken,undefined);assert.equal(args.clientId,undefined);return {protocol:'terminal-session-status-v1',id:value.id,state:value.ended?'STOPPED':'ALIVE',evidence:{confirmed:true},canCloseStopped:value.ended&&value.leaseExpiresAt<=Date.now()};}
      if(operation==='terminal.close'){const value=writer(node,args);if(closeUnconfirmed){closeUnconfirmed=false;return {};}sessions.delete(value.id);return {closed:true};}
      fail('Unexpected synthetic operation: '+operation);
    };
    ({server,service}=await createPortalServer({database:join(folder,'portal.db'),bootstrap,statusPath,origin,secure:false,bridge}));
    clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
    const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'terminal-member',name:'开发成员',password})).result,peer=(await service.invoke(admin.token,'users.create',{username:'terminal-peer',password})).result;
    await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{[machine]:1}});
    await service.invoke(admin.token,'policy.save',{userId:peer.id,policyVersion:0,total:1,limits:{[machine]:1}});
    await service.invoke(admin.token,'users.create',{username:'terminal-zero',password});
    browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
    async function pageFor(username){
      const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
      page.on('pageerror',error=>errors.push(error.message));
      page.on('request',request=>{if(request.url()===origin+'/api/call')requests.push({page,body:request.postDataJSON(),at:Date.now()});});
      await page.addInitScript(()=>{globalThis.__terminalStates=[];document.addEventListener('gpuq-terminal-state',event=>globalThis.__terminalStates.push(event.detail));});
      await context.route('**/*',async route=>{
        const url=new URL(route.request().url());if(url.origin!==origin&&!['data:','blob:'].includes(url.protocol)){outside.push(url.href);return route.abort();}
        if(url.pathname==='/api/call'){
          const {operation,args}=route.request().postDataJSON();
          if(operation==='terminal.exchange'&&args.id===rateId&&rateRemaining>0){rateRemaining--;return route.fulfill({status:429,contentType:'application/json',body:JSON.stringify({error:'请求繁忙，请稍后查询。'})});}
          if(operation==='terminal.exchange'&&args.input&&dropInput){dropInput=false;await route.fetch();return route.abort('connectionreset');}
        }
        return route.continue();
      });
      await page.goto(origin);await page.locator('#login-form [name=username]').fill(username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
      return page;
    }
    async function choose(page,project){await page.waitForFunction(()=>document.querySelector('[name=workspace-machine]')&&!document.querySelector('[name=workspace-machine]').disabled);await page.locator('[name=workspace-machine]').selectOption(machine);await page.locator('[name=workspace-project] option[value="'+project+'"]').waitFor({state:'attached'});await page.locator('[name=workspace-project]').selectOption(project);await page.waitForFunction(()=>!document.querySelector('#terminal-open').disabled);}
    async function open(page){const before=calls.filter(row=>row.operation==='terminal.open'&&row.args.userId===(page===memberPage?member.id:'builtin-admin')).length;await page.locator('#terminal-open').click();await page.locator('.terminal-dialog').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#terminal-screen .xterm'));const opened=calls.filter(row=>row.operation==='terminal.open');assert.ok(opened.length>before);return opened.at(-1).args.key;}
    async function type(page,text){await page.locator('#terminal-screen textarea').focus();await page.keyboard.insertText(text);}
    const exchangeRequests=page=>requests.filter(row=>row.page===page&&row.body.operation==='terminal.exchange');
    async function waitFor(check,label){for(let attempt=0;attempt<250;attempt++){if(check())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Timed out: '+label);}
    async function stop(page){page.once('dialog',dialog=>{assert.equal(dialog.type(),'confirm');assert.match(dialog.message(),/结束这个终端/);return dialog.accept();});await page.locator('#terminal-stop').click();await page.locator('.terminal-dialog').waitFor({state:'hidden'});}
    async function reconnect(page,id,takeover=null){
      const dialogs=new Promise(resolve=>page.once('dialog',async dialog=>{assert.equal(dialog.type(),'prompt');if(takeover!==null)page.once('dialog',async confirm=>{assert.equal(confirm.type(),'confirm');assert.match(confirm.message(),/接管会让另一处失去输入权，已发出的命令不能撤回/);await (takeover?confirm.accept():confirm.dismiss());resolve();});await dialog.accept(id);if(takeover===null)resolve();}));
      await page.locator('#terminal-reconnect').click();
      await dialogs;
      if(takeover!==false)await page.locator('.terminal-dialog').waitFor({state:'visible'});
    }
    async function layouts(page,stem){for(const width of [1440,390]){
      await page.setViewportSize({width,height:width<760?844:1000});await page.evaluate(()=>document.fonts.ready);
      const dimensions=await page.evaluate(()=>({width:innerWidth,html:document.documentElement.scrollWidth,body:document.body.scrollWidth,dialog:document.querySelector('.terminal-dialog')?.getBoundingClientRect().width}));
      assert.ok(dimensions.html<=width+1&&dimensions.body<=width+1&&dimensions.dialog<=width+1,stem+': '+JSON.stringify(dimensions));
      const names=await page.locator('.terminal-dialog .server-id').evaluateAll(items=>items.map(item=>({title:item.title,text:item.textContent})));assert.ok(names.every(item=>item.title===machine&&item.text===machine));
      await page.screenshot({path:join(shots,stem+'-'+width+'.png'),fullPage:true});
    }await page.setViewportSize({width:1440,height:1000});}
    const memberPage=await pageFor('terminal-member');await choose(memberPage,'python-lab');
    const first=await open(memberPage),firstToken=sessions.get(first).writerToken;
    await memberPage.locator('#terminal-collapse').click();const second=await open(memberPage);assert.notEqual(first,second);assert.ok(sessions.has(first));
    await stop(memberPage);assert.ok(sessions.has(first));assert.equal(sessions.has(second),false,'close affects only the selected independent PTY');
    const secondTab=await pageFor('terminal-member');await choose(secondTab,'python-lab');await reconnect(secondTab,first);
    await reconnect(memberPage,first,false);assert.equal(await memberPage.locator('.terminal-dialog').isVisible(),false);assert.equal(requests.filter(row=>row.body.operation==='terminal.open'&&row.body.args.takeover).length,0);
    await reconnect(memberPage,first,true);assert.notEqual(sessions.get(first).writerToken,firstToken);assert.equal(requests.filter(row=>row.body.operation==='terminal.open'&&row.body.args.takeover).length,1);
    await secondTab.context().close();
    await type(memberPage,'confirmed');await waitFor(()=>sessions.get(first).inputs.includes('confirmed'),'confirmed input');await layouts(memberPage,'member-connected');
    dropInput=true;await type(memberPage,'accepted-once');await memberPage.locator('#terminal-connection-note').filter({hasText:'输入未确认，未自动重发'}).waitFor();
    const inputsBefore=sessions.get(first).inputs.length;await type(memberPage,'do-not-replay');await memberPage.waitForTimeout(100);assert.equal(sessions.get(first).inputs.length,inputsBefore);
    await memberPage.locator('#terminal-query').click();assert.equal(sessions.get(first).inputs.filter(value=>value==='accepted-once').length,1);await layouts(memberPage,'member-unconfirmed');
    await memberPage.locator('#terminal-retry').click();await memberPage.waitForFunction(()=>document.querySelector('#terminal-interrupt')?.disabled===false);
    rateId=first;rateRemaining=2;await type(memberPage,'rate-rejected');await memberPage.locator('#terminal-connection-note').filter({hasText:'请求繁忙'}).waitFor();
    const rejectedAt=requests.filter(row=>row.page===memberPage&&row.body.operation==='terminal.exchange'&&row.body.args.input).at(-1).at;
    const requestStart=requests.length,exchangeStart=exchangeRequests(memberPage).length;await type(memberPage,'blocked-backoff');await memberPage.waitForTimeout(500);
    assert.equal(exchangeRequests(memberPage).length,exchangeStart,'typing cannot bypass the initial 1 s backoff');
    await memberPage.locator('#terminal-connection-note').filter({hasText:'连接已恢复'}).waitFor();
    const retries=requests.slice(requestStart).filter(row=>row.page===memberPage&&row.body.operation==='terminal.exchange');
    assert.ok(retries.length>=2);assert.ok(retries.every(row=>!row.body.args.input));assert.ok(retries[0].at-rejectedAt>=900);assert.ok(retries[1].at-retries[0].at>=1900);
    assert.ok(!sessions.get(first).inputs.some(value=>value.includes('rate-rejected')||value.includes('blocked-backoff')));
    heldExchange={id:first,release:null,completed:false};
    await waitFor(()=>heldExchange.release,'validated exchange paused before revocation');
    const expiredLease=Date.now()-1;
    sessions.get(first).revoked=true;sessions.get(first).leaseExpiresAt=expiredLease;
    heldExchange.release();await waitFor(()=>heldExchange.completed,'old exchange released after revocation');
    const race={pausedReadOnly:heldExchange.inputEmpty,revoked:sessions.get(first).revoked,
      leaseStillExpired:sessions.get(first).leaseExpiresAt===expiredLease};
    await writeFile(join(shots,'expiry-race.json'),JSON.stringify(race,null,2));
    if(!race.leaseStillExpired)await memberPage.screenshot({path:join(shots,'expiry-race-failure.png')});
    assert.equal(race.pausedReadOnly,true,'controlled race pauses an already validated read-only exchange');
    assert.equal(race.leaseStillExpired,true,'in-flight exchange cannot renew a revoked or expired writer');
    heldExchange=null;
    await type(memberPage,'expired');await memberPage.locator('#terminal-connection-note').filter({hasText:'已被接管'}).waitFor();
    const expiredCount=exchangeRequests(memberPage).length;await type(memberPage,'must-not-send');await memberPage.waitForTimeout(200);assert.equal(exchangeRequests(memberPage).length,expiredCount);await layouts(memberPage,'member-expired');
    await memberPage.locator('#terminal-retry').click();await memberPage.waitForFunction(()=>document.querySelector('#terminal-interrupt')?.disabled===false);
    sessions.get(first).ended=true;sessions.get(first).exitCode=17;await memberPage.locator('#terminal-connection-note').filter({hasText:'终端已结束（退出码 17）'}).waitFor();
    const exitedOpens=requests.filter(row=>row.body.operation==='terminal.open').length,exitedCloses=requests.filter(row=>row.body.operation==='terminal.close').length;
    await memberPage.waitForTimeout(200);assert.equal(requests.filter(row=>row.body.operation==='terminal.open').length,exitedOpens);assert.equal(requests.filter(row=>row.body.operation==='terminal.close').length,exitedCloses);await layouts(memberPage,'member-ended');
    await memberPage.locator('#terminal-new').click();await waitFor(()=>[...sessions.keys()].some(id=>![first,second].includes(id)),'explicit replacement');await stop(memberPage);
    await choose(memberPage,'container-lab');const container=await open(memberPage);assert.match(await memberPage.locator('#terminal-session-note').textContent(),/^容器终端 · 无 GPU$/);
    await layouts(memberPage,'member-container');await memberPage.locator('#terminal-disconnect').click();
    const containerRequest=requests.find(row=>row.body.operation==='terminal.open'&&row.body.args.key===container);assert.equal(containerRequest.body.args.project,'container-lab');assert.ok(!('hostAdmin'in containerRequest.body.args));
    const beforeRefresh=requests.length;await memberPage.reload();await choose(memberPage,'container-lab');
    await waitFor(()=>requests.slice(beforeRefresh).some(row=>row.body.operation==='terminal.status'&&row.body.args.id===container),'refresh checks the retained original session');
    await memberPage.waitForFunction(id=>globalThis.__terminalStates.at(-1)?.sessions.some(row=>row.id===id&&row.connectionState==='detached'),container);
    const restored=await memberPage.evaluate(id=>globalThis.__terminalStates.at(-1)?.sessions.find(row=>row.id===id),container);
    assert.equal(restored.id,container);assert.equal(restored.machine,machine);assert.equal(restored.project,'container-lab');assert.equal(restored.detached,true);
    assert.ok(!('writerToken'in restored)&&!('clientId'in restored));
    assert.equal(requests.slice(beforeRefresh).some(row=>['terminal.open','terminal.exchange','terminal.close'].includes(row.body.operation)),false,'refresh only reads status; never attaches, inputs or ends');
    assert.equal(await memberPage.locator('#project-terminal-stop').isHidden(),false,'the retained development session still has the project end entry');
    memberPage.once('dialog',async dialog=>{assert.equal(dialog.type(),'prompt');assert.equal(dialog.defaultValue(),container);await dialog.dismiss();});
    await memberPage.locator('#terminal-reconnect').click();
    await memberPage.screenshot({path:join(shots,'member-restored-1440.png'),fullPage:true});
    const duplicateCount=requests.filter(row=>row.body.operation==='terminal.open').length;await memberPage.locator('#terminal-open').click();await memberPage.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('此项目已有开发终端'));
    assert.equal(requests.filter(row=>row.body.operation==='terminal.open').length,duplicateCount+1);assert.ok(sessions.has(container));await reconnect(memberPage,container);
    closeUnconfirmed=true;memberPage.once('dialog',dialog=>dialog.accept());await memberPage.locator('#terminal-stop').click();await memberPage.locator('#terminal-connection-note').filter({hasText:'结束结果未确认'}).waitFor();assert.ok(sessions.has(container));await stop(memberPage);
    const adminPage=await pageFor('admin');await choose(adminPage,'container-lab');const adminContainer=await open(adminPage);await layouts(adminPage,'admin-container');
    await adminPage.locator('#terminal-disconnect').click();const adminBefore=requests.length;await adminPage.reload();await choose(adminPage,'container-lab');
    await waitFor(()=>requests.slice(adminBefore).some(row=>row.body.operation==='terminal.status'&&row.body.args.id===adminContainer),'administrator refresh also checks the original project context');
    await adminPage.waitForFunction(id=>globalThis.__terminalStates.at(-1)?.sessions.some(row=>row.id===id&&row.connectionState==='detached'),adminContainer);
    assert.equal(await adminPage.evaluate(id=>globalThis.__terminalStates.at(-1).sessions.some(row=>row.id===id&&!row.hostAdmin),adminContainer),true);
    assert.equal(requests.slice(adminBefore).some(row=>['terminal.open','terminal.exchange','terminal.close'].includes(row.body.operation)),false);
    await adminPage.screenshot({path:join(shots,'admin-restored-1440.png'),fullPage:true});await reconnect(adminPage,adminContainer);
    const adminRequest=requests.find(row=>row.body.operation==='terminal.open'&&row.body.args.key===adminContainer);assert.ok(!('hostAdmin'in adminRequest.body.args),'administrator container root stays separate from hostAdmin');await stop(adminPage);
    const peerPage=await pageFor('terminal-peer');await choose(peerPage,'python-lab');
    const cross=await peerPage.evaluate(async({machine,id})=>{const response=await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'terminal.open',args:{machine,id,project:'python-lab',clientId:crypto.randomUUID(),key:crypto.randomUUID(),mode:'reconnect'}})});return {status:response.status,body:await response.json()};},{machine,id:first});assert.equal(cross.status,403);assert.match(cross.body.error,/不属于当前账号/);
    const zeroPage=await pageFor('terminal-zero'),before=calls.length;
    const zero=await zeroPage.evaluate(async({machine})=>{const response=await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'terminal.open',args:{machine,key:crypto.randomUUID(),clientId:crypto.randomUUID(),mode:'new'}})});return response.status;},{machine});assert.equal(zero,403);assert.equal(calls.length,before,'zero-grant terminal never reaches the node');
    for(const page of [memberPage,adminPage,peerPage,zeroPage]){
      const exposed=await page.evaluate(()=>JSON.stringify({states:globalThis.__terminalStates,url:location.href,local:{...localStorage},session:{...sessionStorage},text:document.body.textContent}));
      assert.ok(tokens.every(token=>!exposed.includes(token)),'writerToken never appears in shared state, storage, URL or UI');
    }
    assert.ok([...sessions.values()].every(value=>value.maxPending<=1),'each frontend waits for the previous exchange, below the four-request contract limit');
    const closes=calls.filter(row=>row.operation==='terminal.close');assert.ok(closes.every(row=>[second,container,adminContainer].includes(row.args.id)||row.args.id!==first));
    assert.equal(closes.some(row=>row.args.id===first),false,'exit, network errors, takeover and room changes do not close the old PTY');
    assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
    console.log(JSON.stringify({status:'passed',suite:'terminal-contract',shots,checks:['independent PTYs','explicit takeover cost','unknown input stops until reconnect','429 read-only 1s/2s backoff','expired writer fenced','exit code with explicit new action','container project without hostAdmin','refresh preserves original ID and end entry; status only until explicit reconnect','duplicate container rejected','closed:true confirmation','cross-account and zero-grant rejection','writerToken memory only','member/admin 1440/390']}));
  }finally{
    heldExchange?.release?.();
    await browser?.close();if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
    await rm(folder,{recursive:true,force:true});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await terminalContractSmoke();
