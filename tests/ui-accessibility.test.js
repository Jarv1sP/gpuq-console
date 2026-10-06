// Pure local DOM stand-ins/static contracts; no browser, server or real account.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {personalQuotaReadout} from '../dist/workbench-ui.js';

const read=name=>readFileSync(new URL('../dist/'+name,import.meta.url),'utf8');
const app=read('app.js'),start=app.indexOf('function renderUsers(){'),end=app.indexOf('\nfunction renderEditor(){',start);
assert.ok(start>=0&&end>start,'Expected bounded user-list rendering function');
const renderSource=app.slice(start,end);

function fixture(){
  const body={},document={activeElement:body},calls=[];
  const button=id=>({dataset:{user:id},closest:()=>null,focus(options){document.activeElement=this;calls.push({id,options:{...options}});}});
  const list={rows:[],contains(node){return this.rows.includes(node);},querySelectorAll(){return this.rows;},
    set innerHTML(html){
      if(this.contains(document.activeElement))document.activeElement=body;
      this.rows=[...html.matchAll(/data-user="([^"]+)"/g)].map(match=>button(match[1]));
      for(const row of this.rows)row.closest=()=>row;
    }};
  const nodes={'#user-list':list,'#filter-pending':{setAttribute(){}},'#filter-all':{setAttribute(){}}};
  const users=[{id:'user-1',name:'One',total:0},{id:'user-2',name:'Two',total:2}];
  const context={$:id=>nodes[id],document,store:{users},pendingUsers:()=>[],filter:'all',selected:'user-1',
    filteredUsers:()=>context.store.users,esc:String,label:()=>'',personalQuotaReadout};
  const render=vm.runInNewContext('('+renderSource+')',context);render();
  return {body,document,list,calls,context,render};
}

test('user-list refresh restores the focused user, not the selected user, without scrolling',()=>{
  const f=fixture(),old=f.list.rows[1];f.document.activeElement=old;
  f.render();
  assert.notEqual(f.document.activeElement,old);assert.equal(f.document.activeElement.dataset.user,'user-2');
  assert.deepEqual(f.calls,[{id:'user-2',options:{preventScroll:true}}]);
  assert.equal(f.context.selected,'user-1');
});

test('user-list refresh never steals focus from an editor or another list',()=>{
  const f=fixture(),outside={dataset:{user:'user-2'},closest(){return this;}};
  f.document.activeElement=outside;f.render();
  assert.equal(f.document.activeElement,outside);assert.deepEqual(f.calls,[]);
});

test('removed/filtered focused user is not replaced by a different user',()=>{
  const f=fixture();f.document.activeElement=f.list.rows[1];f.context.store.users=f.context.store.users.slice(0,1);
  f.render();assert.equal(f.document.activeElement,f.body);assert.deepEqual(f.calls,[]);
});

test('log and terminal dialogs have names bound to their existing title headings',()=>{
  const execution=read('execution-ui.js'),terminal=read('terminal-ui.js');
  assert.match(execution,/log\.setAttribute\('aria-labelledby','job-log-title'\)/);
  assert.match(execution,/<h2 id="job-log-title">训练日志 · 最近 200 行<\/h2>/);
  assert.match(terminal,/dialog\.setAttribute\('aria-labelledby','terminal-title'\)/);
  assert.match(terminal,/<h2 id="terminal-title"><\/h2>/);
  // Label changes must not replace the existing terminal Escape -> detach contract.
  assert.match(terminal,/addEventListener\('cancel',event=>\{event\.preventDefault\(\);detach\(\);\}\)/);
});
