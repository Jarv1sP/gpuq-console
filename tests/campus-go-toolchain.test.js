import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {campusGoToolchain,CAMPUS_GO_VERSION,CAMPUS_GO_ARCHIVES} from '../scripts/campus-go-toolchain.mjs';

test('campus build pins exact version and official hashes for both Linux targets',async()=>{
  assert.equal(CAMPUS_GO_VERSION,'go1.27.1');
  assert.equal(CAMPUS_GO_ARCHIVES['linux-x64'].sha256,'63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445');
  assert.equal(CAMPUS_GO_ARCHIVES['linux-arm64'].sha256,'3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec');
  let downloads=0;
  await assert.rejects(campusGoToolchain({go:'/fixture/go',readVersion:async()=> 'go1.26.0',fetchArchive:async()=>{downloads++;}}),/exact go1.27.1/);
  assert.equal(await campusGoToolchain({go:'/fixture/exact-go',readVersion:async()=>CAMPUS_GO_VERSION}),'/fixture/exact-go');assert.equal(downloads,0);
});
test('wrong official archive SHA rejects before extraction or execution and removes own folder',async t=>{
  const root=await mkdtemp(join(tmpdir(),'campus-go-sha-'));t.after(()=>rm(root,{recursive:true,force:true}));const versions=[];let extracts=0;
  await assert.rejects(campusGoToolchain({go:null,root,platform:'linux',arch:'x64',readVersion:async path=>{versions.push(path);return null;},extractArchive:async()=>{extracts++;},fetchArchive:async url=>{assert.equal(url,'https://go.dev/dl/go1.27.1.linux-amd64.tar.gz');return new Response('wrong archive');}}),/Official Go archive SHA mismatch/);
  assert.deepEqual(versions,['go']);assert.equal(extracts,0);assert.deepEqual(await readdir(join(root,'build/toolchains')),[]);
});
test('tampered existing Go cache is rejected before executing cached program or downloading',async t=>{
  const root=await mkdtemp(join(tmpdir(),'campus-go-cache-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const target=join(root,'build/toolchains/go1.27.1-linux-x64');await mkdir(join(target,'go/bin'),{recursive:true,mode:0o700});
  const item=CAMPUS_GO_ARCHIVES['linux-x64'];await writeFile(join(target,'verified-source.json'),JSON.stringify({version:CAMPUS_GO_VERSION,...item,source:'https://go.dev/dl/?mode=json&include=all',binarySha256:'0'.repeat(64)}),{mode:0o600});await writeFile(join(target,'go/bin/go'),'tampered',{mode:0o700});
  const versions=[];let downloads=0;
  await assert.rejects(campusGoToolchain({go:null,root,platform:'linux',arch:'x64',readVersion:async path=>{versions.push(path);return null;},fetchArchive:async()=>{downloads++;}}),/cache binary SHA mismatch/);
  assert.deepEqual(versions,['go']);assert.equal(downloads,0);
});
