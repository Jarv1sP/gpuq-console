import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,open,utimes,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {gitSnapshot} from '../client-snapshot-sync.mjs';
import {DATA_CHUNK} from '../client-data-upload.mjs';
const run=promisify(execFile);
async function fixture(t){
  const repo=await mkdtemp(join(tmpdir(),'gpuq-fixed-git-'));
  t.after(()=>rm(repo,{recursive:true,force:true}));
  const git=async(...args)=>(await run('git',['-C',repo,...args],{encoding:'buffer'})).stdout;
  await git('init');await git('config','core.autocrlf','true');await git('config','core.precomposeUnicode','true');
  const commit=async()=>{await git('add','.');await git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','fixed code');};
  return {repo,git,commit};
}
async function readSnapshotFile(scan,entry){
  const file=await scan.openEntry(entry),hash=createHash('sha256');let offset=0;
  try{while(offset<entry.size){const bytes=await file.read(offset);assert.ok(bytes.length>0&&bytes.length<=DATA_CHUNK);offset+=bytes.length;hash.update(bytes);}await file.verify();}
  finally{await file.close();}
  assert.equal(offset,entry.size);assert.equal(hash.digest('hex'),entry.sha256);
}
test('fixed Git snapshots stream blobs larger than the command buffer and retain Unicode paths and empty files',async t=>{
  const f=await fixture(t),directory='données',script=directory+'/启动 café.sh';await mkdir(join(f.repo,directory));
  await writeFile(join(f.repo,script),'#!/bin/sh\necho training\n');await writeFile(join(f.repo,'empty.bin'),'');
  const chunk=Buffer.alloc(DATA_CHUNK,0xab),large=await open(join(f.repo,'large.bin'),'wx'),expected=createHash('sha256');
  try{for(let i=0;i<65;i++){await large.write(chunk);expected.update(chunk);}}finally{await large.close();}
  await f.commit();await f.git('config','core.filemode','false');await f.git('update-index','--chmod=+x',script);await f.git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','executable');
  const scan=await gitSnapshot(f.repo);t.after(()=>scan.cleanup());
  const manifest=JSON.parse(scan.manifest);assert.deepEqual(manifest.directories,[directory]);assert.equal(scan.entries,4);
  assert.deepEqual(manifest.files.map(file=>file.path),[script,'empty.bin','large.bin']);
  assert.equal(manifest.files.find(file=>file.path===script).executable,true);
  const binary=manifest.files.find(file=>file.path==='large.bin');assert.equal(binary.size,65*DATA_CHUNK);assert.equal(binary.sha256,expected.digest('hex'));
  for(const entry of scan.files)await readSnapshotFile(scan,entry);
  const source=await f.git('cat-file','blob',scan.source.commit+':'+script),entry=scan.files.find(file=>file.path===script);assert.equal(entry.sha256,createHash('sha256').update(source).digest('hex'));
  await scan.verify();await scan.cleanup();await assert.rejects(scan.openEntry(entry),/ENOENT/);
});
test('fixed Git snapshots do not execute configured filters or fsmonitor and leave config/index unchanged',async t=>{
  const f=await fixture(t);await writeFile(join(f.repo,'code.txt'),'raw\n');await writeFile(join(f.repo,'.gitattributes'),'code.txt filter=fixture\n');await f.commit();
  for(const [key,value] of [['filter.fixture.clean','exit 96'],['filter.fixture.smudge','exit 95'],['filter.fixture.process','exit 94'],['filter.fixture.required','true'],['core.fsmonitor','exit 93']])await f.git('config',key,value);
  await utimes(join(f.repo,'code.txt'),new Date(0),new Date(0));
  const config=await readFile(join(f.repo,'.git','config')),index=await readFile(join(f.repo,'.git','index'));
  const scan=await gitSnapshot(f.repo);t.after(()=>scan.cleanup());await scan.verify();
  const entry=scan.files.find(file=>file.path==='code.txt');assert.equal(entry.sha256,createHash('sha256').update('raw\n').digest('hex'));await readSnapshotFile(scan,entry);
  assert.deepEqual(await readFile(join(f.repo,'.git','config')),config);assert.deepEqual(await readFile(join(f.repo,'.git','index')),index);
});
test('fixed Git snapshot identity remains immutable and refuses finalization after its ref changes',async t=>{
  const f=await fixture(t);await writeFile(join(f.repo,'code.txt'),'first\n');await f.commit();
  const scan=await gitSnapshot(f.repo);t.after(()=>scan.cleanup());await writeFile(join(f.repo,'code.txt'),'second\n');await f.commit();
  const entry=scan.files[0];assert.equal(entry.sha256,createHash('sha256').update('first\n').digest('hex'));await readSnapshotFile(scan,entry);
  await assert.rejects(scan.verify(),/Git ref changed/);
});
