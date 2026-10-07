import test from 'node:test';
import assert from 'node:assert/strict';
import {terminalUI,endProjectTerminals,terminalRequestContext,terminalExitMessage,terminalStoppedMessage,projectTerminalStorage} from '../dist/terminal-ui.js';
import {maintenanceBlocks} from '../dist/maintenance-state.js';

// Exercise the real event handlers with independently delayed API responses.
// No network, real terminal, credentials, or node is used.
function fixture({storage,principal={userId:'admin',role:'admin'},data,statusReceipt,status}={}){
  const globals=['document','window','CustomEvent','Terminal','FitAddon','setTimeout','clearTimeout','localStorage'];
  const previous=new Map(globals.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const listeners=new Map(),windowListeners=new Map(),calls=[],opens=[],toasts=[],terms=[],timers=new Map(),events=[],confirmations=[];let dialog,authListener,now=0,timerId=0;
  const originalNow=Date.now;Date.now=()=>now;
  const settle=async()=>{for(let index=0;index<10;index++)await Promise.resolve();};
  class Element{
    constructor(id=''){this.id=id;this.disabled=false;this.value='';this.textContent='';this.classList={toggle(){}};}
    setAttribute(){}addEventListener(){}close(){this.open=false;}showModal(){this.open=true;}replaceChildren(){}closest(){return this;}
  }
  const elements=new Map([
    ['#page-admin:not([hidden]) #admin-maintenance-console',new Element('admin-maintenance-console')],
    ['[name=terminal-machine]',Object.assign(new Element(),{value:'node-a'})],
    ['[name=dataset-machine]',Object.assign(new Element(),{value:'node-b'})],
    ['[name=workspace-project]',Object.assign(new Element(),{value:'experiment'})],
    ['[name=workspace-machine]',Object.assign(new Element(),{value:'node-a'})],
    ...['terminal-title','terminal-session-note','terminal-screen','terminal-connection-note','terminal-maintenance-note','terminal-root-identity-note','terminal-interrupt','terminal-query','terminal-retry','terminal-new'].map(id=>['#'+id,new Element(id)])
  ]);
  globalThis.document={querySelector:name=>elements.get(name),createElement:()=>dialog=new Element(),body:{append(){}},addEventListener:(name,fn)=>listeners.set(name,fn),dispatchEvent:event=>{events.push(event);return listeners.get(event.type)?.(event);}};
  globalThis.CustomEvent=class{constructor(type,args){this.type=type;this.detail=args.detail;}};
  Object.defineProperty(globalThis,'localStorage',{configurable:true,writable:true,value:storage});
  globalThis.window={confirm:message=>{confirmations.push(message);return true;},prompt:()=>'',addEventListener:(name,fn)=>windowListeners.set(name,fn)};
  globalThis.Terminal=class{
    constructor(){this.cols=80;this.rows=24;this.writes=[];this.lines=[];terms.push(this);}
    loadAddon(){}open(){}onData(handler){this.input=handler;}focus(){}dispose(){this.disposed=true;}
    write(data){this.writes.push(new TextDecoder().decode(data));}writeln(data){this.lines.push(data);}
  };
  globalThis.FitAddon={FitAddon:class{fit(){}}};
  globalThis.setTimeout=(handler,delay=0)=>{const id=++timerId;timers.set(id,{handler,at:now+delay});return id;};
  globalThis.clearTimeout=id=>timers.delete(id);
  const store={principal,data,statusReceipt,status,authGeneration:0,onAuthChange(fn){authListener=fn;},async call(operation,args,lifecycle={}){
    calls.push({operation,args,at:now});
    if(operation==='terminal.open'){
      const result=await new Promise((resolve,reject)=>opens.push({args,resolve,reject}));
      lifecycle.accept?.(result);return result;
    }
    if(operation==='terminal.detach'&&store.failDetach)throw Error('fixture detach unavailable');
    if(operation==='terminal.close'&&store.failClose)throw Error('fixture close unavailable');
    if(operation==='terminal.status')return store.status?store.status(args,lifecycle):store.statusReceipt||{protocol:'terminal-session-status-v1',id:args.id,state:'UNKNOWN',evidence:{confirmed:false}};
    if(operation==='terminal.close')return store.closeReceipt||{closed:true};
    if(operation==='terminal.detach')return {detached:true};
    if(operation==='projects.list'){
      const control=elements.get('[name=workspace-project]');
      return {projects:[{project:control.selectedOptions?.[0]?.dataset?.project||control.value,environmentMode:store.environmentMode||'shared'}]};
    }
    if(operation==='terminal.exchange'&&store.exchange)return store.exchange(args);
    return {offset:0,data:'',exited:false};
  }};
  terminalUI(store,message=>toasts.push(message));
  const context=()=>listeners.get('gpuq-workspace-context')({detail:{userId:store.principal.userId,machine:elements.get('[name=terminal-machine]').value,project:elements.get('[name=workspace-project]').value}});
  context();
  return {store,calls,opens,toasts,context,terms,events,confirmations,elements,
    dataContext:()=>listeners.get('gpuq-data-workspace-context')(),
    leave:()=>listeners.get('gpuq-route-leaving')(),pagehide:()=>windowListeners.get('pagehide')(),
    setPrompt:value=>{globalThis.window.prompt=()=>value;},
    setConfirm:value=>{globalThis.window.confirm=message=>{confirmations.push(message);return value;};},
    click:id=>listeners.get('click')({target:new Element(id)}),
    title:()=>elements.get('#terminal-title').textContent,
    visible:()=>dialog?.open===true,
    note:()=>elements.get('#terminal-connection-note').textContent,
    jump:duration=>{now+=duration;},
    authChanged:()=>authListener((operation,args)=>store.call(operation,args)),
    settle,
    input:data=>terms.at(-1).input(data),
    exchanges:()=>calls.filter(call=>call.operation==='terminal.exchange'),
    delay:()=>timers.size?Math.min(...[...timers.values()].map(timer=>timer.at-now)):null,
    advance:async duration=>{
      const end=now+duration;let count=0;
      while(true){
        const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
        if(!next||next[1].at>end)break;
        assert.ok(count++<1000,'unexpected timer loop');now=next[1].at;timers.delete(next[0]);next[1].handler();await settle();
      }
      now=end;await settle();
    },
    resolve:(index,id)=>opens[index].resolve({id,writerToken:id+'-writer'}),
    restore(){Date.now=originalNow;for(const [name,descriptor]of previous)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}
  };
}

for(const [first,second,label]of [
  ['terminal-root-open','terminal-open','个人开发'],
  ['terminal-open','terminal-root-open','ROOT 运维'],
  ['terminal-root-open','terminal-data-open','个人数据'],
  ['terminal-data-open','terminal-open','个人开发'],
])test(`late ${first} cannot replace newer ${second} or keep its writer`,async()=>{
  const f=fixture();try{
    const old=f.click(first);await f.settle();const latest=f.click(second);await f.settle();
    assert.equal(f.opens.length,2);f.resolve(1,'latest');await latest;
    assert.match(f.title(),new RegExp(label));f.resolve(0,'stale');await old;
    assert.match(f.title(),new RegExp(label));assert.ok(f.title().endsWith('latest'));
    assert.deepEqual(f.calls.filter(call=>call.operation==='terminal.detach').map(call=>call.args.id),['stale']);
    assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false,'superseded session is retained, not destroyed');
  }finally{f.restore();}
});

async function attach(f,id='development',entry='terminal-open'){
  const opened=f.click(entry);await f.settle();f.resolve(f.opens.length-1,id);await opened;await f.settle();
}
test('leaving maintenance while ROOT open is pending releases its writer without killing the node session',async()=>{
  const f=fixture();try{
    const opening=f.click('terminal-root-open');await f.settle();assert.equal(f.opens.length,1);
    f.elements.delete('#page-admin:not([hidden]) #admin-maintenance-console');
    f.resolve(0,'retired-root');await opening;
    assert.equal(f.visible(),false);
    assert.deepEqual(f.calls.filter(call=>call.operation==='terminal.detach').map(call=>call.args.id),['retired-root']);
    assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);
  }finally{f.restore();}
});
const inputOf=call=>Buffer.from(call.args.input,'base64').toString();
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('typing uses a fixed 20 ms batch window and cannot be starved by continued input',async()=>{
  const f=fixture();try{
    await attach(f);assert.equal(f.exchanges().length,1);
    f.input('a');await f.advance(10);f.input('b');await f.advance(9);f.input('c');
    assert.equal(f.exchanges().length,1,'input waits only for the original batching deadline');
    await f.advance(1);
    assert.equal(f.exchanges().length,2);assert.equal(f.exchanges()[1].at,20);assert.equal(inputOf(f.exchanges()[1]),'abc');
    assert.equal(f.delay(),80,'activity resets the output follow-up interval');
  }finally{f.restore();}
});

test('input arriving during an exchange flushes immediately after it, with no overlapping requests',async()=>{
  const f=fixture(),slow=deferred();try{
    await attach(f);f.store.exchange=()=>slow.promise;
    f.input('first');await f.advance(20);assert.equal(f.exchanges().length,2);
    f.input('second');await f.advance(500);assert.equal(f.exchanges().length,2);
    f.store.exchange=()=>({offset:5,data:'',exited:false});slow.resolve({offset:5,data:'',exited:false});await f.settle();
    assert.equal(f.delay(),0,'in-flight typing must not wait for an idle poll');
    await f.advance(0);
    assert.deepEqual(f.exchanges().slice(1).map(inputOf),['first','second']);
    assert.equal(f.exchanges()[2].at,520);assert.equal(f.exchanges()[2].args.offset,5);
  }finally{slow.resolve({offset:0,data:'',exited:false});await f.settle();f.restore();}
});

test('large pastes drain ordered 8192-byte chunks without another idle delay',async()=>{
  const f=fixture();try{
    await attach(f);const text='x'.repeat(16384)+'tail';f.input(text);await f.advance(20);
    const sent=f.exchanges().slice(1);
    assert.deepEqual(sent.map(call=>inputOf(call).length),[8192,8192,4]);
    assert.equal(sent.map(inputOf).join(''),text);assert.ok(sent.every(call=>call.at===20));
  }finally{f.restore();}
});

test('idle polling backs off to 750 ms and new input interrupts the idle wait',async()=>{
  const f=fixture();try{
    await attach(f);assert.equal(f.delay(),120);
    const observed=[];
    for(let index=0;index<7;index++){await f.advance(f.delay());observed.push(f.delay());}
    assert.deepEqual(observed,[180,270,405,608,750,750,750]);
    const before=f.exchanges().length;f.input('wake');assert.equal(f.delay(),20);
    await f.advance(20);assert.equal(f.exchanges().length,before+1);assert.equal(inputOf(f.exchanges().at(-1)),'wake');
    assert.equal(f.delay(),80);
  }finally{f.restore();}
});

test('ambiguous exchange errors neither retry accepted bytes nor automatically send queued input',async()=>{
  const f=fixture(),slow=deferred();try{
    await attach(f);f.store.exchange=()=>slow.promise;
    f.input('accepted-once');await f.advance(20);f.input('unsent-');
    slow.reject(Error('reply lost'));await f.settle();
    assert.equal(f.delay(),null);assert.ok(f.terms.at(-1).lines.some(line=>line.includes('reply lost')));
    await f.advance(10000);assert.equal(f.exchanges().length,2);
    f.store.exchange=()=>({offset:0,data:'',exited:false});f.input('new');await f.advance(20);
    assert.deepEqual(f.exchanges().slice(1).map(inputOf),['accepted-once'],'new typing cannot resume the old input queue after an uncertain reply');
    assert.equal(f.delay(),null);assert.match(f.note(),/输入未确认，未自动重发/);
    await attach(f,'development','terminal-retry');f.input('only-new-after-reconnect');await f.advance(20);
    assert.deepEqual(f.exchanges().slice(1).map(inputOf),['accepted-once','','only-new-after-reconnect'],'explicit reconnect never carries the uncertain or unsent old input');
  }finally{slow.resolve({offset:0,data:'',exited:false});await f.settle();f.restore();}
});

test('a stale exchange cannot write into the new terminal or carry old input and offsets across generations',async()=>{
  const f=fixture(),slow=deferred();try{
    await attach(f,'old');f.store.exchange=args=>args.id==='old'?slow.promise:{offset:3,data:btoa('new'),exited:false};
    f.input('old-input');await f.advance(20);f.input('discard-old-queued');
    await attach(f,'new','terminal-root-open');f.input('new-input');
    assert.equal(f.exchanges().length,2,'new generation waits for the old in-flight request to settle');
    slow.resolve({offset:900,data:btoa('stale-output'),exited:false});await f.settle();assert.equal(f.delay(),0);
    await f.advance(0);const next=f.exchanges().at(-1);
    assert.equal(next.args.id,'new');assert.equal(next.args.hostAdmin,true);assert.equal(next.args.offset,0);assert.equal(inputOf(next),'new-input');
    assert.deepEqual(f.terms.at(-1).writes,['new']);assert.ok(f.title().endsWith('new'));
    assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);
  }finally{slow.resolve({offset:0,data:'',exited:false});await f.settle();f.restore();}
});

test('disconnect cancels the input batch without sending it or closing the remote session',async()=>{
  const f=fixture();try{
    await attach(f);f.input('never-send');await f.advance(10);await f.click('terminal-disconnect');await f.advance(1000);
    assert.equal(f.exchanges().length,1);assert.equal(f.visible(),false);
    assert.equal(f.calls.filter(call=>call.operation==='terminal.detach').length,1);
    assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);
  }finally{f.restore();}
});

test('auth changes cancel queued typing and suppress the old generation response',async()=>{
  const f=fixture(),slow=deferred();try{
    await attach(f);f.store.exchange=()=>slow.promise;f.input('old-input');await f.advance(20);f.input('never-send');
    f.store.authGeneration++;await f.authChanged();
    slow.resolve({offset:99,data:btoa('private-old-output'),exited:false});await f.settle();await f.advance(1000);
    assert.equal(f.visible(),false);assert.equal(f.exchanges().length,2);assert.equal(f.delay(),null);
    assert.deepEqual(f.terms.at(-1).writes,[]);
    assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);
  }finally{slow.resolve({offset:0,data:'',exited:false});await f.settle();f.restore();}
});

test('an unconfirmed stop cancels the old batching marker and resumes typing only after explicit reconnect',async()=>{
  const f=fixture();try{
    await attach(f);f.input('unsent-');await f.advance(10);f.store.failClose=true;
    await f.click('terminal-stop');assert.ok(f.toasts.some(message=>message.includes('fixture close unavailable')));
    assert.equal(f.visible(),true);f.input('new');await f.advance(20);
    assert.equal(f.exchanges().length,1);assert.match(f.note(),/结束结果未确认，请重新查询/);
    await attach(f,'development','terminal-retry');f.input('fresh');await f.advance(20);
    assert.equal(f.exchanges().length,3);assert.equal(inputOf(f.exchanges().at(-1)),'fresh','the old batching marker cannot block fresh input, and the old queue cannot resume');
    assert.equal(f.calls.filter(call=>call.operation==='terminal.close').length,1,'failed close is never automatically retried');
  }finally{f.restore();}
});

test('newer open failure cannot revive the earlier pending ROOT request',async()=>{
  const f=fixture();try{
    const root=f.click('terminal-root-open');await f.settle();const dev=f.click('terminal-open');await f.settle();
    f.opens[1].reject(Error('fixture new development failed'));await dev;f.resolve(0,'stale-root');await root;
    assert.equal(f.visible(),false);assert.ok(f.toasts.some(text=>text.includes('fixture new development failed')));
    assert.deepEqual(f.calls.filter(call=>call.operation==='terminal.detach').map(call=>call.args.id),['stale-root']);
  }finally{f.restore();}
});

test('late open failure cannot detach or replace the successful newer terminal',async()=>{
  const f=fixture();try{
    const root=f.click('terminal-root-open');await f.settle();const dev=f.click('terminal-open');await f.settle();
    f.resolve(1,'development');await dev;f.opens[0].reject(Error('active writer'));await root;
    assert.ok(f.title().endsWith('development'));assert.equal(f.visible(),true);
    assert.equal(f.opens.length,2,'obsolete failures must not retry with takeover');
  }finally{f.restore();}
});

test('unconfirmed stale writer cleanup reports the failure without attaching ROOT',async()=>{
  const f=fixture();try{
    const root=f.click('terminal-root-open');await f.settle();const dev=f.click('terminal-open');await f.settle();
    f.resolve(1,'development');await dev;f.store.failDetach=true;f.resolve(0,'stale-root');await root;
    assert.ok(f.title().endsWith('development'));assert.ok(f.toasts.some(text=>text.includes('写入权释放未确认')));
  }finally{f.restore();}
});

test('a replacement intent releases the attached writer before opening another terminal',async()=>{
  const f=fixture();try{
    const dev=f.click('terminal-open');await f.settle();f.resolve(0,'development');await dev;
    const root=f.click('terminal-root-open');await f.settle();
    const detach=f.calls.findIndex(call=>call.operation==='terminal.detach');
    const open=f.calls.findLastIndex(call=>call.operation==='terminal.open');assert.ok(detach>=0&&detach<open);
    f.resolve(1,'root');await root;assert.ok(f.title().endsWith('root'));
  }finally{f.restore();}
});

test('disconnect invalidates an older open still pending in the same workspace',async()=>{
  const f=fixture();try{
    const root=f.click('terminal-root-open');await f.settle();const dev=f.click('terminal-open');await f.settle();
    f.resolve(1,'development');await dev;await f.click('terminal-disconnect');f.resolve(0,'stale-root');await root;
    assert.equal(f.visible(),false);
    assert.deepEqual(f.calls.filter(call=>call.operation==='terminal.detach').map(call=>call.args.id),['development','stale-root']);
  }finally{f.restore();}
});

test('ordinary users cannot send a ROOT request even through a forged visible button',async()=>{
  const f=fixture();try{
    f.store.principal.role='member';await f.click('terminal-root-open');
    assert.equal(f.opens.length,0);assert.ok(f.toasts.some(text=>text.includes('仅管理员')));
  }finally{f.restore();}
});

test('data terminal uses the dataset machine and propagates scope through exchange and close',async()=>{
  const f=fixture();try{
    f.store.principal.role='member';await attach(f,'data','terminal-data-open');
    const open=f.opens[0].args;assert.equal(open.machine,'node-b');assert.equal(open.dataWorkspace,true);assert.equal(open.hostAdmin,false);assert.ok(!('project'in open));
    f.input('tar --help');await f.advance(20);await f.click('terminal-stop');
    for(const call of f.calls.filter(value=>value.operation.startsWith('terminal.')&&value.args.id==='data')){assert.equal(call.args.machine,'node-b');assert.equal(call.args.dataWorkspace,true);assert.ok(!('project'in call.args));}
    assert.equal(f.visible(),false);
  }finally{f.restore();}
});

test('data context change fences late data open and only releases its writer, never destroys it',async()=>{
  const f=fixture();try{
    const opened=f.click('terminal-data-open');await f.settle();f.dataContext();f.resolve(0,'old-data');await opened;
    assert.equal(f.visible(),false);const detach=f.calls.find(value=>value.operation==='terminal.detach');assert.equal(detach.args.dataWorkspace,true);assert.equal(detach.args.id,'old-data');assert.equal(f.calls.some(value=>value.operation==='terminal.close'),false);
  }finally{f.restore();}
});

test('data session cannot silently reconnect through the development or ROOT entry',async()=>{
  const f=fixture();try{
    await attach(f,'personal-data','terminal-data-open');await f.click('terminal-disconnect');f.setPrompt('personal-data');
    await f.click('terminal-reconnect');await f.click('terminal-root-reconnect');
    assert.equal(f.opens.length,1);assert.equal(f.toasts.filter(message=>message.includes('终端类型')).length,2);
    const reconnect=f.click('terminal-data-reconnect');await f.settle();assert.equal(f.opens[1].args.dataWorkspace,true);assert.equal(f.opens[1].args.id,'personal-data');f.resolve(1,'personal-data');await reconnect;
    assert.match(f.title(),/个人数据/);
  }finally{f.restore();}
});

test('data machine changes do not detach an attached workbench terminal',async()=>{
  const f=fixture();try{await attach(f);f.dataContext();assert.equal(f.visible(),true);assert.equal(f.calls.some(call=>call.operation==='terminal.detach'),false);}finally{f.restore();}
});

test('new requests use distinct keys and never inherit an old session or writer',async()=>{
  const f=fixture();try{
    await attach(f,'first');await attach(f,'second');
    const [first,second]=f.opens.map(open=>open.args);
    assert.equal(first.mode,'new');assert.equal(second.mode,'new');assert.notEqual(first.key,second.key);assert.notEqual(first.clientId,second.clientId);
    for(const request of [first,second]){assert.ok(!Object.hasOwn(request,'id'));assert.ok(!Object.hasOwn(request,'writerToken'));assert.ok(!Object.hasOwn(request,'takeover'));}
    assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);
  }finally{f.restore();}
});

test('reconnect takeover is sent only after the separate cost confirmation',async()=>{
  const f=fixture();try{
    await attach(f,'retained');await f.click('terminal-disconnect');f.setPrompt('retained');f.setConfirm(false);
    const refused=f.click('terminal-reconnect');await f.settle();assert.equal(f.opens[1].args.mode,'reconnect');assert.equal(f.opens[1].args.id,'retained');assert.ok(!('writerToken'in f.opens[1].args));
    f.opens[1].reject(Error('Terminal has another active writer'));await refused;
    assert.equal(f.opens.length,2);assert.match(f.confirmations.at(-1),/接管会让另一处失去输入权，已发出的命令不能撤回/);
    f.setConfirm(true);const approved=f.click('terminal-reconnect');await f.settle();f.opens[2].reject(Error('Terminal has another active writer'));await f.settle();
    assert.equal(f.opens[3].args.takeover,true);assert.equal(f.opens[3].args.id,'retained');assert.notEqual(f.opens[2].args.key,f.opens[3].args.key);assert.equal(f.opens[2].args.clientId,f.opens[3].args.clientId);
    f.resolve(3,'retained');await approved;
  }finally{f.restore();}
});

test('writerToken stays in the attached connection, never in announced state or reconnect arguments',async()=>{
  const f=fixture();try{
    await attach(f,'secret');assert.equal(f.exchanges()[0].args.writerToken,'secret-writer');
    for(const event of f.events.filter(value=>value.type==='gpuq-terminal-state')){
      assert.equal(JSON.stringify(event.detail).includes('secret-writer'),false);
      assert.ok(event.detail.sessions.every(value=>!Object.hasOwn(value,'writerToken')&&!Object.hasOwn(value,'writeUntil')));
    }
    await f.click('terminal-disconnect');f.setPrompt('secret');const reopened=f.click('terminal-reconnect');await f.settle();
    assert.ok(!Object.hasOwn(f.opens[1].args,'writerToken'),'detached directory never restores the old writer');f.resolve(1,'secret');await reopened;
  }finally{f.restore();}
});

test('429 backs off read-only queries and never resends the rejected or queued bytes',async()=>{
  const f=fixture();try{
    await attach(f);let attempts=0;f.store.exchange=()=>{if(++attempts<=2)throw Object.assign(Error('busy'),{status:429});return {offset:9,data:'',exited:false};};
    f.input('once');await f.advance(20);assert.equal(f.delay(),1000);assert.match(f.note(),/未自动重发/);
    f.input('never-send');await f.advance(999);assert.equal(f.exchanges().length,2);
    await f.click('terminal-query');assert.equal(f.exchanges().length,2,'manual query cannot bypass the backoff');
    await f.advance(1);assert.equal(f.delay(),2000);assert.equal(inputOf(f.exchanges().at(-1)),'');
    await f.advance(1999);assert.equal(f.exchanges().length,3);await f.advance(1);
    assert.deepEqual(f.exchanges().slice(1).map(inputOf),['once','','']);assert.match(f.note(),/之前的输入未重发/);
    f.input('new-after-backoff');await f.advance(20);assert.equal(inputOf(f.exchanges().at(-1)),'new-after-backoff');
  }finally{f.restore();}
});

test('an expired local attachment cannot send another input and requires explicit reconnect',async()=>{
  const f=fixture();try{
    await attach(f);f.jump(16000);const before=f.calls.length;f.input('expired-input');await f.settle();
    assert.equal(f.calls.length,before);assert.match(f.note(),/连接已过期，请重连/);assert.equal(f.delay(),null);
    await attach(f,'development','terminal-retry');f.input('fresh-input');await f.advance(20);
    assert.equal(f.opens[1].args.mode,'reconnect');assert.ok(!('writerToken'in f.opens[1].args));assert.equal(inputOf(f.exchanges().at(-1)),'fresh-input');
  }finally{f.restore();}
});

test('server-side takeover or expiry fences old input and old close credentials',async()=>{
  const f=fixture();try{
    await attach(f);f.store.exchange=()=>{throw Error('Terminal writer lease expired or was taken over; reconnect explicitly');};
    f.input('rejected');await f.advance(20);const before=f.calls.length;f.input('never-send');await f.advance(1000);
    assert.equal(f.calls.length,before);assert.match(f.note(),/已被接管.*输入未确认，未自动重发/);
    assert.ok(f.terms.at(-1).lines.every(line=>!line.includes('writer lease')),'internal lease terms are not member copy');
    const stop=f.click('terminal-stop');await f.settle();assert.equal(f.opens.length,2);assert.equal(f.opens[1].args.mode,'reconnect');assert.ok(!('writerToken'in f.opens[1].args));
    assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);f.resolve(1,'development');await stop;
    assert.equal(f.calls.filter(call=>call.operation==='terminal.close').length,1);
  }finally{f.restore();}
});

test('exited output reports the returned exit code and never closes or opens a replacement automatically',async()=>{
  const f=fixture();try{
    await attach(f);f.store.exchange=()=>({offset:3,data:btoa('bye'),exited:true,exitCode:7});await f.advance(f.delay());
    assert.match(f.note(),/^终端已结束（退出码 7）$/);assert.equal(f.elements.get('#terminal-new').hidden,false);assert.equal(f.delay(),null);
    f.input('never-send');await f.advance(60000);assert.equal(f.opens.length,1);assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);
    assert.deepEqual(f.terms.at(-1).writes,['bye']);
    const explicit=f.click('terminal-new');await f.settle();assert.equal(f.opens.length,2);assert.equal(f.opens[1].args.mode,'new');assert.ok(!('id'in f.opens[1].args));f.resolve(1,'fresh');await explicit;
    assert.equal(terminalExitMessage({exitCode:null}),'终端已结束（退出码未提供）');
  }finally{f.restore();}
});

test('container terminals use only their project context and display the confirmed no-GPU label',async()=>{
  const f=fixture();try{
    f.store.environmentMode='oci';await attach(f,'container');assert.match(f.title(),/experiment.*容器终端 · 无 GPU/);
    assert.equal(f.elements.get('#terminal-session-note').textContent,'容器终端 · 无 GPU');
    for(const call of f.calls.filter(value=>value.operation.startsWith('terminal.'))){assert.equal(call.args.project,'experiment');assert.ok(!Object.hasOwn(call.args,'hostAdmin'));assert.ok(!Object.hasOwn(call.args,'environmentMode'));}
    assert.deepEqual(terminalRequestContext({machine:'node-a',project:'experiment',hostAdmin:false}),{machine:'node-a',project:'experiment'});
    const duplicate=f.click('terminal-open');await f.settle();f.opens[1].reject(Object.assign(Error('This project already has a development terminal'),{status:409}));await duplicate;
    assert.ok(f.toasts.some(value=>value.includes('already has a development terminal')));assert.equal(f.opens.length,2,'no substitute container/terminal is created');assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);
  }finally{f.restore();}
});

test('a close is successful only with closed:true, and cancel sends no close at all',async()=>{
  const f=fixture();try{
    await attach(f);f.setConfirm(false);await f.click('terminal-stop');assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);
    f.setConfirm(true);f.store.closeReceipt={};await f.click('terminal-stop');assert.equal(f.visible(),true);assert.match(f.note(),/结束结果未确认，请重新查询/);
    assert.ok(f.toasts.some(value=>value.includes('结束结果未确认')));assert.equal(f.events.at(-1).detail.sessions.length,1);
    f.store.closeReceipt={closed:true};await f.click('terminal-stop');assert.equal(f.visible(),false);assert.deepEqual(f.events.at(-1).detail.sessions,[]);
  }finally{f.restore();}
});

test('endProjectTerminals confirms, matches machine+project+actor and closes each retained session',async()=>{
  const f=fixture();try{
    await attach(f,'first');await attach(f,'second');
    f.elements.get('[name=workspace-project]').value='other';f.context();await attach(f,'other');
    f.setConfirm(false);assert.equal(await endProjectTerminals({machine:'node-a',project:'experiment'}),false);assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);
    f.setConfirm(true);const end=endProjectTerminals({machine:'node-a',project:'experiment'});await f.settle();
    assert.equal(f.opens[3].args.id,'first');f.resolve(3,'first');await f.settle();assert.equal(f.opens[4].args.id,'second');f.resolve(4,'second');assert.equal(await end,true);
    const closes=f.calls.filter(call=>call.operation==='terminal.close');assert.deepEqual(closes.map(call=>call.args.id),['first','second']);
    assert.ok(closes.every(call=>call.args.machine==='node-a'&&call.args.project==='experiment'&&!('hostAdmin'in call.args)));
    assert.ok(f.title().endsWith('other'));assert.equal(f.visible(),true);
    assert.deepEqual(f.events.at(-1).detail.sessions.map(value=>value.id),['other']);
  }finally{f.restore();}
});
test('cancelled project-terminal cleanup cannot close after a delayed reconnect completes',async()=>{
  const f=fixture();try{
    await attach(f,'retained');await f.click('terminal-disconnect');
    const controller=new AbortController(),end=endProjectTerminals({machine:'node-a',project:'experiment'},{signal:controller.signal});
    const rejected=assert.rejects(end,error=>error.name==='AbortError');await f.settle();assert.equal(f.opens.length,2);
    controller.abort();await rejected;f.resolve(1,'retained');await f.settle();
    assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);assert.equal(f.opens.length,2,'cancellation never reconnects or takes over again');
    assert.equal(f.confirmations.length,1);
  }finally{f.restore();}
});
test('project-terminal cleanup rejects another writer without offering takeover',async()=>{
  const f=fixture();try{
    await attach(f,'elsewhere');await f.click('terminal-disconnect');
    const end=endProjectTerminals({machine:'node-a',project:'experiment'});
    const rejected=assert.rejects(end,/这个终端正在别处使用，请在那里结束/);await f.settle();
    f.opens[1].reject(Error('Terminal has another active writer'));await rejected;
    assert.equal(f.confirmations.length,1,'only the project-ending confirmation is shown');assert.equal(f.opens.length,2);assert.equal(f.calls.some(call=>call.operation==='terminal.close'||call.args?.takeover),false);
  }finally{f.restore();}
});

test('old actor sessions cannot be revealed or closed by the next account',async()=>{
  const f=fixture();try{
    await attach(f,'old-private');f.store.authGeneration++;await f.authChanged();f.store.principal={userId:'other',role:'member'};f.context();
    const before=f.calls.length;document.dispatchEvent(new CustomEvent('gpuq-terminal-reveal',{detail:{id:'old-private',userId:'other'}}));
    assert.equal(await endProjectTerminals({machine:'node-a',project:'experiment'}),true,'the next actor has no sessions to end');
    assert.equal(f.calls.length,before);assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);assert.equal(f.visible(),false);
    const oldRelease=f.calls.find(call=>call.operation==='terminal.detach');assert.equal(oldRelease.args.writerToken,'old-private-writer');
  }finally{f.restore();}
});

test('a lost new-open reply retains its original ID for explicit checking, never creates a second request automatically',async()=>{
  const f=fixture();try{
    const opened=f.click('terminal-open');await f.settle();const original=f.opens[0].args;
    f.opens[0].reject(Object.assign(Error('reply lost'),{code:'REQUEST_TIMEOUT'}));await opened;await f.advance(60000);
    assert.equal(f.opens.length,1);assert.equal(f.visible(),false);assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);
    const retained=f.events.filter(value=>value.type==='gpuq-terminal-state').at(-1).detail.sessions[0];assert.equal(retained.id,original.key);assert.equal(retained.connectionState,'unknown');assert.ok(!('writerToken'in retained));assert.ok(f.toasts.some(value=>value.includes(original.key)));
    f.setPrompt(original.key);const retry=f.click('terminal-reconnect');await f.settle();assert.equal(f.opens[1].args.id,original.key);assert.equal(f.opens[1].args.mode,'reconnect');assert.ok(!('writerToken'in f.opens[1].args));f.resolve(1,original.key);await retry;
  }finally{f.restore();}
});

test('maintenance ROOT launch keeps the explicit host entry even when only a machine context is supplied',async()=>{
  const f=fixture();try{
    f.store.data={machines:[{id:'node-a'}]};
    document.dispatchEvent(new CustomEvent('gpuq-maintenance-root',{detail:{machine:'node-a',userId:'admin'}}));await f.settle();
    assert.equal(f.opens.length,1);assert.equal(f.opens[0].args.hostAdmin,true);assert.ok(!('project'in f.opens[0].args));assert.match(f.confirmations[0],/宿主机 ROOT/);
    f.resolve(0,'maintenance-root');await f.settle();assert.match(f.title(),/ROOT 运维/);
  }finally{f.restore();}
});

test('directory option identity keeps development source separate from the ROOT focus',async()=>{
  const f=fixture();try{
    Object.assign(f.elements.get('[name=workspace-project]'),{value:'["node-a","experiment"]',selectedOptions:[{dataset:{project:'experiment',machine:'node-a'}}]});
    f.elements.get('[name=workspace-machine]').value='node-b';
    await attach(f,'development-source');
    assert.equal(f.opens[0].args.machine,'node-a');assert.equal(f.opens[0].args.project,'experiment');assert.ok(!('hostAdmin'in f.opens[0].args));
    await attach(f,'host-focus','terminal-root-open');
    assert.equal(f.opens[1].args.machine,'node-b');assert.equal(f.opens[1].args.hostAdmin,true);assert.ok(!('project'in f.opens[1].args));
  }finally{f.restore();}
});
test('failed original reconnect checks only status and clearly marks ended without automatic replacement',async()=>{
 const f=fixture();try{
  await attach(f,'original-ended');await f.click('terminal-disconnect');f.setPrompt('original-ended');
  f.store.statusReceipt={protocol:'terminal-session-status-v1',id:'original-ended',state:'STOPPED',evidence:{confirmed:true}};
  const pending=f.click('terminal-reconnect');await f.settle();f.opens[1].reject(Error('Terminal is not reachable; no replacement was started'));await pending;
  assert.equal(f.opens.length,2);assert.equal(f.visible(),false);assert.ok(f.toasts.some(text=>/终端已结束.*明确新建/.test(text)));
  const status=f.calls.filter(c=>c.operation==='terminal.status');assert.equal(status.length,1);assert.equal(status[0].args.id,'original-ended');assert.ok(!('writerToken'in status[0].args)&&!('clientId'in status[0].args));
  const retained=f.events.filter(e=>e.type==='gpuq-terminal-state').at(-1).detail.sessions[0];assert.equal(retained.connectionState,'ended');
  f.store.closeReceipt={protocol:'terminal-session-status-v1',id:'original-ended',state:'STOPPED',metadataOnly:true,closed:true};
  const before=f.opens.length;assert.equal(await endProjectTerminals({machine:'node-a',project:'experiment'}),true);assert.equal(f.opens.length,before);
  const close=f.calls.filter(c=>c.operation==='terminal.close');assert.equal(close.length,1);assert.equal(close[0].args.id,'original-ended');assert.ok(!('writerToken'in close[0].args)&&!('clientId'in close[0].args));
 }finally{f.restore();}
});
test('unknown or wrong original status never claims stopped and cannot invent a replacement',async()=>{
 for(const status of [{protocol:'terminal-session-status-v1',id:'retained',state:'UNKNOWN',evidence:{confirmed:false}},{protocol:'terminal-session-status-v1',id:'different',state:'STOPPED',evidence:{confirmed:true}},{protocol:'terminal-session-status-v1',id:'retained',state:'STOPPED',evidence:{confirmed:false}}]){
  const f=fixture();try{
   await attach(f,'retained');await f.click('terminal-disconnect');f.setPrompt('retained');f.store.statusReceipt=status;
   const pending=f.click('terminal-reconnect');await f.settle();f.opens[1].reject(Error('Terminal is not reachable'));await pending;
   assert.equal(f.opens.length,2);assert.equal(f.calls.some(c=>c.operation==='terminal.close'),false);assert.ok(!f.toasts.some(t=>t.includes('终端已结束')));
   assert.equal(terminalStoppedMessage(status,'retained'),null);
  }finally{f.restore();}
 }
});

function memoryStorage(){
 const values=new Map();return {get length(){return values.size;},key:index=>[...values.keys()][index],getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
}
const retainedId='a1234567-1234-4234-8234-123456789abc',peerId='b1234567-1234-4234-8234-123456789abc';
const retainedContext={userId:'admin',machine:'node-a',project:'experiment'};
const recoveryData={machines:[{id:'node-a'}]};
test('persistent project identities are scoped by actor, machine and project and never contain credentials',()=>{
 const storage=memoryStorage(),saved=projectTerminalStorage(storage);
 saved.remember({...retainedContext,id:retainedId,writerToken:'private-writer',clientId:'private-client',authGeneration:7,output:'private-output'});
 saved.remember({...retainedContext,id:peerId});
 saved.remember({...retainedContext,machine:'node-b',project:'other',id:retainedId});
 saved.remember({...retainedContext,userId:'peer',id:peerId});
 saved.remember({...retainedContext,id:peerId,hostAdmin:true});saved.remember({...retainedContext,id:peerId,dataWorkspace:true});
 assert.deepEqual(saved.list('admin'),[{...retainedContext,id:retainedId},{...retainedContext,id:peerId},{...retainedContext,machine:'node-b',project:'other',id:retainedId}]);
 assert.deepEqual(saved.list('peer'),[{...retainedContext,userId:'peer',id:peerId}]);assert.deepEqual(saved.list('zero'),[]);
 const text=Array.from({length:storage.length},(_,index)=>storage.getItem(storage.key(index))).join('');
 for(const secret of ['writerToken','clientId','authGeneration','output','private-'])assert.equal(text.includes(secret),false);
 saved.forget({...retainedContext,id:retainedId});assert.ok(saved.list('admin').some(row=>row.id===retainedId&&row.machine==='node-b'));
 assert.ok(saved.list('peer').some(row=>row.id===peerId),'closing never erases another account or source');
});
test('invalid or disabled storage does not fabricate sessions or break the in-memory terminal',async()=>{
 const storage=memoryStorage(),saved=projectTerminalStorage(storage);
 saved.remember({...retainedContext,id:'invalid'});assert.equal(storage.length,0);
 saved.remember({...retainedContext,id:retainedId});storage.setItem(storage.key(0),'{broken');assert.deepEqual(saved.list('admin'),[]);
 const blocked={get length(){throw Error('disabled');},setItem(){throw Error('full');}};
 assert.deepEqual(projectTerminalStorage(blocked).list('admin'),[]);assert.equal(projectTerminalStorage(blocked).remember({...retainedContext,id:retainedId}),false);
 const f=fixture({storage:blocked});try{await attach(f,retainedId);assert.equal(f.visible(),true);assert.ok(f.toasts.some(text=>text.includes('复制后再刷新')));}finally{f.restore();}
});
test('refresh restores the original development ID and only probes status until explicit reconnect or end',async()=>{
 const storage=memoryStorage();let f=fixture({storage});
 try{await attach(f,retainedId);await f.click('terminal-disconnect');}finally{f.restore();}
 f=fixture({storage,data:recoveryData,statusReceipt:{protocol:'terminal-session-status-v1',id:retainedId,state:'ALIVE',evidence:{confirmed:true}}});
 try{
  await f.settle();assert.deepEqual(f.calls.map(row=>row.operation),['terminal.status']);
  assert.deepEqual(f.calls[0].args,{machine:'node-a',project:'experiment',id:retainedId});
  assert.equal(f.events.at(-1).detail.sessions[0].connectionState,'detached');assert.equal(f.visible(),false);
  let defaultId;window.prompt=(message,value)=>{defaultId=value;return value;};
  const pending=f.click('terminal-reconnect');await f.settle();assert.equal(defaultId,retainedId);
  assert.equal(f.opens[0].args.mode,'reconnect');assert.equal(f.opens[0].args.id,retainedId);assert.ok(!('writerToken'in f.opens[0].args));
  f.resolve(0,retainedId);await pending;assert.equal(f.visible(),true);
  await f.click('terminal-stop');assert.deepEqual(projectTerminalStorage(storage).list('admin'),[]);
  assert.equal(f.calls.filter(row=>row.operation==='terminal.close').length,1);
 }finally{f.restore();}
});
test('confirmed stopped recovery uses the existing metadata-only close; unknown or wrong receipts retain the ID',async()=>{
 for(const receipt of [
  {protocol:'terminal-session-status-v1',id:retainedId,state:'STOPPED',evidence:{confirmed:true}},
  {protocol:'terminal-session-status-v1',id:retainedId,state:'UNKNOWN',evidence:{confirmed:false}},
  {protocol:'terminal-session-status-v1',id:peerId,state:'STOPPED',evidence:{confirmed:true}}
 ]){
  const storage=memoryStorage();projectTerminalStorage(storage).remember({...retainedContext,id:retainedId});
  const f=fixture({storage,data:recoveryData,statusReceipt:receipt});try{
   await f.settle();const confirmed=receipt.id===retainedId&&receipt.state==='STOPPED';
   assert.equal(f.events.at(-1).detail.sessions[0].connectionState,confirmed?'ended':'unknown');
   assert.equal(projectTerminalStorage(storage).list('admin')[0].id,retainedId);
   assert.equal(f.calls.some(row=>row.operation==='terminal.open'||row.operation==='terminal.close'),false);
   if(confirmed){
    f.store.closeReceipt={protocol:'terminal-session-status-v1',id:retainedId,closed:false,state:'STOPPED',metadataOnly:true};
    await assert.rejects(endProjectTerminals({machine:'node-a',project:'experiment'}),/未确认/);
    assert.equal(projectTerminalStorage(storage).list('admin').length,1);
    f.store.closeReceipt={...f.store.closeReceipt,closed:true};assert.equal(await endProjectTerminals({machine:'node-a',project:'experiment'}),true);
    assert.deepEqual(projectTerminalStorage(storage).list('admin'),[]);
    assert.ok(f.calls.filter(row=>row.operation==='terminal.close').every(row=>!('writerToken'in row.args)&&!('clientId'in row.args)));
   }
  }finally{f.restore();}
 }
});
test('account changes and missing machine grants never probe or reveal another actor ID',async()=>{
 const storage=memoryStorage();projectTerminalStorage(storage).remember({...retainedContext,id:retainedId});
 const peer=fixture({storage,principal:{userId:'peer',role:'member'},data:recoveryData});try{await peer.settle();assert.deepEqual(peer.events.at(-1).detail.sessions,[]);assert.deepEqual(peer.calls,[]);}finally{peer.restore();}
 const zero=fixture({storage,data:{machines:[]}});try{await zero.settle();assert.deepEqual(zero.calls,[]);assert.equal(projectTerminalStorage(storage).list('admin')[0].id,retainedId);}finally{zero.restore();}
});
test('recovery status is aborted on project changes, logout, room leave and pagehide; stale STOPPED cannot win',async()=>{
 for(const action of ['project','logout','leave','pagehide']){
  const storage=memoryStorage();projectTerminalStorage(storage).remember({...retainedContext,id:retainedId});
  let respond,signal;const f=fixture({storage,data:recoveryData,status:(_args,options)=>{signal=options.signal;return new Promise(resolve=>{respond=resolve;});}});try{
   await f.settle();
   assert.ok(signal,'restored ID is checked without attachment');
   if(action==='project'){f.elements.get('[name=workspace-project]').value='other';f.context();}
   else if(action==='logout'){f.store.authGeneration++;await f.authChanged();f.store.principal=null;}
   else f[action]();
   assert.equal(signal.aborted,true);
   respond({protocol:'terminal-session-status-v1',id:retainedId,state:'STOPPED',evidence:{confirmed:true}});await f.settle();
   const own=f.events.filter(row=>row.type==='gpuq-terminal-state').at(-1).detail.sessions.find(row=>row.id===retainedId);
   assert.notEqual(own?.connectionState,'ended');assert.equal(projectTerminalStorage(storage).list('admin')[0].id,retainedId);
   assert.equal(f.calls.some(row=>row.operation==='terminal.close'),false);
  }finally{f.restore();}
 }
});
test('maintenance permits original-session status only, without enabling terminal creation',()=>{
 const data={operationalMaintenance:{version:1,global:{reason:'repair'},machines:{}}},principal={role:'member'};
 assert.equal(maintenanceBlocks('terminal.status',{machine:'node-a',project:'experiment',id:retainedId},data,principal),null);
 assert.ok(maintenanceBlocks('terminal.open',{machine:'node-a',project:'experiment'},data,principal));
});
