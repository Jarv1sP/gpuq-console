// Native browser-cookie race regression, using loopback-only mock identities.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const events=[];let stateGate,loginGate,terminalGate,browser;
const server=createServer(async(req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<script type="module">import {DemoClient} from "/client.js"; window.client=new DemoClient(); client.remote=true; client.production=true;</script>');}
  if(req.url==='/client.js'){res.setHeader('Content-Type','text/javascript');return res.end(await readFile(new URL('../dist/client.js',import.meta.url)));}
  const parts=[];for await(const part of req)parts.push(part);const body=JSON.parse(Buffer.concat(parts).toString()||'{}');
  const actor=(req.headers.cookie||'').match(/fixture_session=([^;]+)/)?.[1];
  events.push({path:req.url,operation:body.operation,username:body.username,actor});
  const send=(status,data,cookie)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');if(cookie)res.setHeader('Set-Cookie',cookie);res.end(JSON.stringify(data));};
  if(req.url==='/api/login'){
    if(loginGate){const gate=loginGate;loginGate=null;await gate.promise;}
    return send(200,{principal:{userId:body.username},state:{users:[{id:body.username}],jobs:[]}},`fixture_session=${body.username}; Path=/; HttpOnly; SameSite=Strict`);
  }
  if(body.operation==='state'&&stateGate){const gate=stateGate;stateGate=null;await gate.promise;return send(401,{error:'fixture expired'},'fixture_session=; Path=/; HttpOnly; Max-Age=0');}
  if(body.operation==='terminal.open'){await terminalGate.promise;return send(200,{result:{id:'fixture-terminal'}});}
  if(body.operation==='terminal.close')return send(200,{result:{closed:true}});
  return send(200,{principal:{userId:actor},state:{users:[{id:actor}],jobs:[]},result:{actor}});
});
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage();await page.context().route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin);await page.waitForFunction(()=>window.client);await page.evaluate(()=>client.login('old','fixture'));
  const cookie=async()=>(await page.context().cookies()).find(item=>item.name==='fixture_session')?.value;
  const waitEvent=async predicate=>{const end=Date.now()+3000;while(!events.some(predicate)){if(Date.now()>end)throw Error('fixture request did not arrive');await new Promise(resolve=>setTimeout(resolve,10));}};
  stateGate=defer();const expired=stateGate;
  await page.evaluate(()=>{window.old=client.call('state').catch(error=>error.code);window.newLogin=client.login('new','fixture');});
  await waitEvent(event=>event.operation==='state');assert.equal(events.some(event=>event.username==='new'),false);expired.resolve();
  assert.equal(await page.evaluate(()=>old),'STALE_SESSION');await page.evaluate(()=>newLogin);assert.equal(await cookie(),'new');assert.equal(await page.evaluate(()=>client.principal.userId),'new');
  loginGate=defer();const firstLogin=loginGate;
  await page.evaluate(()=>{window.first=client.login('first','fixture').catch(error=>error.code);});await waitEvent(event=>event.username==='first');
  await page.evaluate(()=>{window.second=client.login('second','fixture');});assert.equal(events.some(event=>event.username==='second'),false);firstLogin.resolve();
  assert.equal(await page.evaluate(()=>first),'STALE_SESSION');await page.evaluate(()=>second);assert.equal(await cookie(),'second');
  stateGate=defer();const timedOut=stateGate;
  await page.evaluate(()=>{client.requestTimeoutMs=100;window.timeoutCall=client.call('state').catch(error=>error.code);window.afterTimeout=client.login('after-timeout','fixture');});
  assert.equal(await page.evaluate(()=>timeoutCall),'STALE_SESSION');await page.evaluate(()=>afterTimeout);timedOut.resolve();await page.waitForTimeout(150);
  assert.equal(await cookie(),'after-timeout','aborted old 401 must not clear the new browser cookie');
  terminalGate=defer();
  await page.evaluate(()=>{client.requestTimeoutMs=45000;window.attached=false;window.opened=client.call('terminal.open',{}, {accept:()=>{attached=true;},onStale:(result,call)=>call('terminal.close',{id:result.id})}).catch(error=>error.code);window.lastLogin=client.login('last','fixture');});
  await waitEvent(event=>event.operation==='terminal.open');assert.equal(events.some(event=>event.username==='last'),false);terminalGate.resolve();
  assert.equal(await page.evaluate(()=>opened),'STALE_SESSION');await page.evaluate(()=>lastLogin);assert.equal(await page.evaluate(()=>attached),false);
  const close=events.findIndex(event=>event.operation==='terminal.close'),last=events.findIndex(event=>event.username==='last');assert.ok(close>=0&&close<last);assert.equal(events[close].actor,'after-timeout');assert.equal(await cookie(),'last');
  console.log(JSON.stringify({status:'passed',checks:['native HttpOnly cookie order','old 401 drain','overlapping login order','timeout abort cookie isolation','original-identity late terminal cleanup']}));
}finally{stateGate?.resolve();loginGate?.resolve();terminalGate?.resolve();await browser?.close();await new Promise(resolve=>server.close(resolve));}
