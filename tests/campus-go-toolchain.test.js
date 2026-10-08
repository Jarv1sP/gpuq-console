import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {campusGoToolchain,CAMPUS_GO_VERSION,CAMPUS_GO_ARCHIVES} from '../scripts/campus-go-toolchain.mjs';

test('campus build pins exact version and official hashes for both Linux targets',async()=>{
  assert.equal(CAMPUS_GO_VERSION,'go1.27.1');
  assert.equal(CAMPUS_GO_ARCHIVES['linux-x64'].sha256,'63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445');
  assert.equal(CAMPUS_GO_ARCHIVES['linux-arm64'].sha256,'3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec');
  let downloads=0;
  await assert.rejects(campusGoToolchain({go:'/fixture/go',readVersion:async()=> 'go1.26.0',fetchArchive:async()=>{downloads++;}}),/exact go1.27.1/);
  assert.equal(await campusGoToolchain({go:'/fixture/exact-go',readVersion:async()=>CAMPUS_GO_VERSION}),'/fixture/exact-go');assert.equal(downloads,0);
});
test('Windows build hosts use pinned official ZIPs and verify go.exe before execution',async t=>{
  assert.deepEqual(CAMPUS_GO_ARCHIVES['win32-x64'],{filename:'go1.27.1.windows-amd64.zip',sha256:'a3911b5e0e1b1053f25ed0675f4c1c6aad1e2bfcf253df2b9be4caabd2edd95d'});
  assert.deepEqual(CAMPUS_GO_ARCHIVES['win32-arm64'],{filename:'go1.27.1.windows-arm64.zip',sha256:'13b69b87bb0e83f96bc68560a8cace7f0343b1e03469f1110ea18d17e3234069'});
  const root=await mkdtemp(join(tmpdir(),'campus-go-windows-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const target=join(root,'build/toolchains/go1.27.1-win32-x64'),tool=join(target,'go/bin/go.exe'),bytes=Buffer.from('fixture Windows binary');
  await mkdir(join(target,'go/bin'),{recursive:true,mode:0o700});
  await writeFile(tool,bytes,{mode:0o700});
  await writeFile(join(target,'verified-source.json'),JSON.stringify({version:CAMPUS_GO_VERSION,...CAMPUS_GO_ARCHIVES['win32-x64'],source:'https://go.dev/dl/?mode=json&include=all',binarySha256:createHash('sha256').update(bytes).digest('hex')}),{mode:0o600});
  const versions=[];let downloads=0;
  const options={go:null,root,platform:'win32',arch:'x64',readVersion:async path=>{versions.push(path);return path===tool?CAMPUS_GO_VERSION:null;},fetchArchive:async()=>{downloads++;}};
  assert.equal(await campusGoToolchain(options),tool);assert.deepEqual(versions,['go',tool]);assert.equal(downloads,0);
  await writeFile(tool,'tampered');versions.length=0;
  await assert.rejects(campusGoToolchain(options),/cache binary SHA mismatch/);assert.deepEqual(versions,['go']);assert.equal(downloads,0);
});
test('Windows ZIP SHA is checked before extraction or executing go.exe',async t=>{
  const root=await mkdtemp(join(tmpdir(),'campus-go-windows-sha-'));t.after(()=>rm(root,{recursive:true,force:true}));const versions=[];let extracts=0;
  await assert.rejects(campusGoToolchain({go:null,root,platform:'win32',arch:'x64',readVersion:async path=>{versions.push(path);return null;},extractArchive:async()=>{extracts++;},fetchArchive:async url=>{assert.equal(url,'https://go.dev/dl/go1.27.1.windows-amd64.zip');return new Response('wrong archive');}}),/Official Go archive SHA mismatch/);
  assert.deepEqual(versions,['go']);assert.equal(extracts,0);assert.deepEqual(await readdir(join(root,'build/toolchains')),[]);
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
