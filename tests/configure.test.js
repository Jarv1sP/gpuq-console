import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateInventory} from '../scripts/configure.mjs';
const template=JSON.parse(await readFile(new URL('../config/inventory.example.json',import.meta.url),'utf8'));
test('deployment inventory accepts separate domains and arbitrary machine capacity',()=>{
  const c=structuredClone(template);c.nodes=c.nodes.slice(0,1);c.nodes[0].cards=3;
  assert.equal(validateInventory(c).nodes[0].cards,3);
});
test('deployment inventory rejects ambiguous or injectable configuration',()=>{
  for(const change of [c=>c.publicOrigin='http://gpu.example.com',c=>c.publicOrigin='https://user:secret@gpu.example.com',c=>c.publicOrigin='https://gpu.example.com/path',c=>c.headscaleOrigin=c.publicOrigin,c=>c.vpsTailIP='host;id',c=>c.nodes[0].address='x$(id)',c=>c.nodes[0].user='root;id',c=>c.nodes[0].workspaceRoot='/srv/../etc',c=>c.nodes[0].workspaceRoot=c.nodes[0].gpuqRoot,c=>c.nodes.push(c.nodes[0]),c=>c.nodes[0].cards=0]){
    const c=structuredClone(template);change(c);assert.throws(()=>validateInventory(c));
  }
});
