import test from 'node:test';
import assert from 'node:assert/strict';
import {terminalUI} from '../dist/terminal-ui.js';

// Exercise the real event handlers with independently delayed API responses.
// No network, real terminal, credentials, or node is used.
function fixture(){
  const globals=['document','window','CustomEvent','Terminal','FitAddon','setTimeout','clearTimeout'];
  const previous=new Map(globals.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const listeners=new Map(),calls=[],opens=[],toasts=[];let dialog,authListener;
  class Element{
    constructor(id=''){this.id=id;this.disabled=false;this.value='';this.textContent='';this.classList={toggle(){}};}
    setAttribute(){}addEventListener(){}close(){this.open=false;}showModal(){this.open=true;}replaceChildren(){}closest(){return this;}
  }
  const elements=new Map([
    ['[name=terminal-machine]',Object.assign(new Element(),{value:'node-a'})],
    ['[name=workspace-project]',Object.assign(new Element(),{value:'experiment'})],
    ...['terminal-title','terminal-session-note','terminal-screen'].map(id=>['#'+id,new Element(id)])
  ]);
  globalThis.document={querySelector:name=>elements.get(name),createElement:()=>dialog=new Element(),body:{append(){}},addEventListener:(name,fn)=>listeners.set(name,fn),dispatchEvent:event=>listeners.get(event.type)?.(event)};
  globalThis.CustomEvent=class{constructor(type,args){this.type=type;this.detail=args.detail;}};
  globalThis.window={confirm:()=>true,prompt:()=>'',addEventListener(){}};
  globalThis.Terminal=class{constructor(){this.cols=80;this.rows=24;}loadAddon(){}open(){}onData(){}focus(){}dispose(){}write(){}writeln(){}};
  globalThis.FitAddon={FitAddon:class{fit(){}}};
  globalThis.setTimeout=()=>1;globalThis.clearTimeout=()=>{};
  const store={principal:{userId:'admin',role:'admin'},authGeneration:0,onAuthChange(fn){authListener=fn;},async call(operation,args,lifecycle={}){
    calls.push({operation,args});
    if(operation==='terminal.open'){
      const result=await new Promise((resolve,reject)=>opens.push({args,resolve,reject}));
      lifecycle.accept?.(result);return result;
    }
    if(operation==='terminal.detach'&&store.failDetach)throw Error('fixture detach unavailable');
    return {offset:0,data:'',exited:false};
  }};
  terminalUI(store,message=>toasts.push(message));
  const context=()=>listeners.get('gpuq-workspace-context')({detail:{userId:store.principal.userId,machine:elements.get('[name=terminal-machine]').value,project:elements.get('[name=workspace-project]').value}});
  context();
  return {store,calls,opens,toasts,context,
    click:id=>listeners.get('click')({target:new Element(id)}),
    title:()=>elements.get('#terminal-title').textContent,
    visible:()=>dialog?.open===true,
    authChanged:()=>authListener((operation,args)=>store.call(operation,args)),
    settle:async()=>{await Promise.resolve();await Promise.resolve();},
    resolve:(index,id)=>opens[index].resolve({id,writerToken:id+'-writer'}),
    restore(){for(const [name,descriptor]of previous)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}
  };
}

for(const [first,second,label]of [
  ['terminal-root-open','terminal-open','个人开发'],
  ['terminal-open','terminal-root-open','ROOT 运维'],
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
