import test from 'node:test';
import assert from 'node:assert/strict';
import {terminalUI} from '../dist/terminal-ui.js';

// Exercise the real event handlers with independently delayed API responses.
// No network, real terminal, credentials, or node is used.
function fixture(){
  const globals=['document','window','CustomEvent','Terminal','FitAddon','setTimeout','clearTimeout'];
  const previous=new Map(globals.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const listeners=new Map(),calls=[],opens=[],toasts=[],terms=[],timers=new Map();let dialog,authListener,now=0,timerId=0;
  const settle=async()=>{for(let index=0;index<10;index++)await Promise.resolve();};
  class Element{
    constructor(id=''){this.id=id;this.disabled=false;this.value='';this.textContent='';this.classList={toggle(){}};}
    setAttribute(){}addEventListener(){}close(){this.open=false;}showModal(){this.open=true;}replaceChildren(){}closest(){return this;}
  }
  const elements=new Map([
    ['[name=terminal-machine]',Object.assign(new Element(),{value:'node-a'})],
    ['[name=dataset-machine]',Object.assign(new Element(),{value:'node-b'})],
    ['[name=workspace-project]',Object.assign(new Element(),{value:'experiment'})],
    ...['terminal-title','terminal-session-note','terminal-screen'].map(id=>['#'+id,new Element(id)])
  ]);
  globalThis.document={querySelector:name=>elements.get(name),createElement:()=>dialog=new Element(),body:{append(){}},addEventListener:(name,fn)=>listeners.set(name,fn),dispatchEvent:event=>listeners.get(event.type)?.(event)};
  globalThis.CustomEvent=class{constructor(type,args){this.type=type;this.detail=args.detail;}};
  globalThis.window={confirm:()=>true,prompt:()=>'',addEventListener(){}};
  globalThis.Terminal=class{
    constructor(){this.cols=80;this.rows=24;this.writes=[];this.lines=[];terms.push(this);}
    loadAddon(){}open(){}onData(handler){this.input=handler;}focus(){}dispose(){this.disposed=true;}
    write(data){this.writes.push(new TextDecoder().decode(data));}writeln(data){this.lines.push(data);}
  };
  globalThis.FitAddon={FitAddon:class{fit(){}}};
  globalThis.setTimeout=(handler,delay=0)=>{const id=++timerId;timers.set(id,{handler,at:now+delay});return id;};
  globalThis.clearTimeout=id=>timers.delete(id);
  const store={principal:{userId:'admin',role:'admin'},authGeneration:0,onAuthChange(fn){authListener=fn;},async call(operation,args,lifecycle={}){
    calls.push({operation,args,at:now});
    if(operation==='terminal.open'){
      const result=await new Promise((resolve,reject)=>opens.push({args,resolve,reject}));
      lifecycle.accept?.(result);return result;
    }
    if(operation==='terminal.detach'&&store.failDetach)throw Error('fixture detach unavailable');
    if(operation==='terminal.close'&&store.failClose)throw Error('fixture close unavailable');
    if(operation==='terminal.exchange'&&store.exchange)return store.exchange(args);
    return {offset:0,data:'',exited:false};
  }};
  terminalUI(store,message=>toasts.push(message));
  const context=()=>listeners.get('gpuq-workspace-context')({detail:{userId:store.principal.userId,machine:elements.get('[name=terminal-machine]').value,project:elements.get('[name=workspace-project]').value}});
  context();
  return {store,calls,opens,toasts,context,terms,
    dataContext:()=>listeners.get('gpuq-data-workspace-context')(),
    setPrompt:value=>{globalThis.window.prompt=()=>value;},
    click:id=>listeners.get('click')({target:new Element(id)}),
    title:()=>elements.get('#terminal-title').textContent,
    visible:()=>dialog?.open===true,
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
    restore(){for(const [name,descriptor]of previous)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}
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
    assert.deepEqual(f.exchanges().slice(1).map(inputOf),['accepted-once','unsent-new']);
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

test('a failed stop cancels the old batching marker so subsequent typing can still be sent',async()=>{
  const f=fixture();try{
    await attach(f);f.input('unsent-');await f.advance(10);f.store.failClose=true;
    await f.click('terminal-stop');assert.ok(f.toasts.some(message=>message.includes('fixture close unavailable')));
    assert.equal(f.visible(),true);f.input('new');await f.advance(20);
    assert.equal(f.exchanges().length,2);assert.equal(inputOf(f.exchanges().at(-1)),'unsent-new');
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
