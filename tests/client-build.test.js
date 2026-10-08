import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {buildClient} from '../scripts/build-client.mjs';
import {standaloneClient} from '../client-bundle.mjs';
import {createPortalServer} from '../portal-server.mjs';

test('normal bundler follows nested modules, resolves name collisions, and produces identical bytes',async t=>{
  const roots=await Promise.all([mkdtemp(join(tmpdir(),'gpuq-build-a-')),mkdtemp(join(tmpdir(),'gpuq-build-b-'))]);
  t.after(()=>Promise.all(roots.map(path=>rm(path,{recursive:true,force:true}))));
  const outputs=[];
  for(const root of roots){
    await mkdir(join(root,'nested'));await writeFile(join(root,'package.json'),'{"type":"module"}');
    await writeFile(join(root,'cli.mjs'),"#!/usr/bin/env node\nimport {answer} from './nested/answer.js';\nconst value=5;console.log(answer()+value);\n");
    await writeFile(join(root,'nested/answer.js'),"import {value} from './value.js'; export const answer=()=>value;\n");
    await writeFile(join(root,'nested/value.js'),"export const value=7;\n");
    await writeFile(join(root,'.env'),'GPUQ_TEST_SECRET=do-not-bundle-this-synthetic-config\n');
    const result=await buildClient({root});const output=join(root,'build/gpuctl.mjs'),bytes=await readFile(output);
    outputs.push(bytes);assert.equal(Object.keys(result.metafile.outputs).length,1);
    assert.deepEqual(Object.keys(result.metafile.inputs).sort(),['cli.mjs','nested/answer.js','nested/value.js']);
    assert.doesNotMatch(bytes.toString(),/do-not-bundle|sourceMappingURL|esbuild/);
    const executed=spawnSync(process.execPath,[output],{encoding:'utf8'});assert.equal(executed.status,0,executed.stderr);assert.equal(executed.stdout.trim(),'12');
  }
  assert.deepEqual(outputs[0],outputs[1]);
});

test('real CLI bundle has only Node builtin external imports and retains origin as one safe JS literal',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'gpuq-build-graph-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const result=await buildClient({outfile:join(folder,'gpuctl.mjs')}),imports=Object.values(result.metafile.outputs)[0].imports;
  assert.ok(imports.length>0);assert.ok(imports.every(item=>item.external&&item.path.startsWith('node:')));
  assert.ok(result.metafile.inputs['cli.mjs']);
  const source=await standaloneClient('https://gpu.example.com');assert.doesNotMatch(source,/__GPUQ_PUBLIC_ORIGIN__|sourceMappingURL/);
  const syntax=spawnSync(process.execPath,['--input-type=module','--check'],{input:source,encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);
  // Substitution serializes the whole string, even if a future caller passes
  // unexpected quote/backslash content. It never substitutes executable code.
  const unusual=await standaloneClient('https://fixture.example/$&/"; throw new Error("bad")');
  assert.equal(spawnSync(process.execPath,['--input-type=module','--check'],{input:unusual,encoding:'utf8'}).status,0);
});

test('runtime artifact reader needs neither source CLI modules nor installed esbuild',async t=>{
  const root=await mkdtemp(join(tmpdir(),'gpuq-client-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'build'));
  await copyFile(new URL('../client-bundle.mjs',import.meta.url),join(root,'client-bundle.mjs'));
  await copyFile(new URL('../build/gpuctl.mjs',import.meta.url),join(root,'build/gpuctl.mjs'));
  const output=spawnSync(process.execPath,['--input-type=module','-e',"import {standaloneClient} from './client-bundle.mjs'; process.stdout.write(await standaloneClient('https://runtime.example'));"],{cwd:root,encoding:'utf8'});
  assert.equal(output.status,0,output.stderr);assert.match(output.stdout,/https:\/\/runtime\.example/);assert.doesNotMatch(output.stdout,/__GPUQ_PUBLIC_ORIGIN__/);
});

test('portal downloads installable one-file artifact and installed symlink executes it',async t=>{
  const root=await mkdtemp(join(tmpdir(),'gpuq-built-installer-')),bootstrap=join(root,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Build-Test-Administrator-Password-2026!'}));
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const origin='http://127.0.0.1:'+port,{server}=await createPortalServer({database:join(root,'db'),bootstrap,origin,secure:false});
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const response=await fetch(origin+'/gpuctl.mjs');assert.equal(response.status,200);const source=await response.text();assert.match(source,/^#!\/usr\/bin\/env node/);
  assert.equal(source,await standaloneClient(origin));assert.doesNotMatch(source,/__GPUQ_PUBLIC_ORIGIN__/);
  // These are the installer's syntax-validation, single file and symlink
  // steps, performed exclusively under this temporary fixture directory.
  const syntax=spawnSync(process.execPath,['--input-type=module','--check'],{input:source,encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);
  const client=join(root,'gpuctl.mjs'),link=join(root,'gpuctl');await writeFile(client,source,{mode:0o700});await symlink(client,link);
  const help=spawnSync(process.execPath,[link,'--help'],{encoding:'utf8'});assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/jobs \/ logs JOB \/ cancel JOB/);assert.match(help.stdout,/data upload FILE.tar.gz/);
  assert.match(help.stdout,/data prepare NAME@VERSION/);assert.match(help.stdout,/--via direct/);
  assert.doesNotMatch(help.stdout,/data shell|data put ARCHIVE|data workspace-status|--via relay/);
  const installer=await(await fetch(origin+'/install.sh')).text();assert.match(installer,/node --input-type=module --check/);assert.match(installer,/gpuctl\.mjs/);assert.doesNotMatch(installer,/__GPUQ_PUBLIC_ORIGIN__/);
});
