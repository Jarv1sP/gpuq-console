#!/usr/bin/env node
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {isIP} from 'node:net';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export function validateInventory(c){
  for(const key of ['publicOrigin','headscaleOrigin']){
    const u=new URL(c[key]);
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||!/^[-a-z0-9.]+$/.test(u.hostname))throw Error('Use HTTPS DNS origins without paths, credentials or ports');
  }
  if(c.publicOrigin===c.headscaleOrigin)throw Error('Portal and Headscale need different hostnames');
  if(isIP(c.vpsTailIP)!==4)throw Error('vpsTailIP must be an IPv4 address');
  if(!Array.isArray(c.nodes)||!c.nodes.length||c.nodes.length>64)throw Error('Use 1–64 nodes');
  const ids=new Set();
  for(const n of c.nodes){
    if(!/^[a-z][a-z0-9-]{1,31}$/.test(n.id)||ids.has(n.id))throw Error('Invalid/duplicate node id');ids.add(n.id);
    if(isIP(n.address)!==4||!/^[a-z_][a-z0-9_-]{0,31}$/.test(n.user))throw Error('Invalid node address/account');
    if(!Number.isInteger(n.cards)||n.cards<1||n.cards>64||!/^\d+ GB$/.test(n.memory)||typeof n.model!=='string'||n.model.length>80)throw Error('Invalid GPU specification');
    for(const key of ['workspaceRoot','gpuqRoot','conda'])if(!/^\/[a-zA-Z0-9_./-]+$/.test(n[key])||n[key].split('/').includes('..')||n[key]==='/')throw Error('Invalid absolute node path');
    if(n.workspaceRoot===n.gpuqRoot)throw Error('Workspace and scheduler must be separate');
  }
  return c;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const c=validateInventory(JSON.parse(await readFile(process.argv[2]||'inventory.json','utf8')));
  const machines=c.nodes.map(({id,model,cards,memory})=>({id,model,cards,memory}));
  await writeFile('dist/machines.js','// Generated from local inventory; contains no network addresses.\nexport const MACHINES=Object.freeze('+JSON.stringify(machines,null,2)+');\n');
  await writeFile('.env',`PORTAL_DOMAIN=${new URL(c.publicOrigin).hostname}\nHEADSCALE_DOMAIN=${new URL(c.headscaleOrigin).hostname}\n`,{mode:0o600});
  await mkdir('generated',{recursive:true,mode:0o700});
  const config=(await readFile('deploy/headscale.yaml','utf8')).replaceAll('https://tail.example.com',c.headscaleOrigin);
  await writeFile('generated/headscale.yaml',config,{mode:0o600});
  console.log(`Prepared ${machines.length} nodes. Review changes before building; no remote services changed.`);
}
