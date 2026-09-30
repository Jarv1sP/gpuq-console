// Source-context checks only: no Docker daemon or image build is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {matchesGlob} from 'node:path';

test('all current Docker COPY sources survive the context, including Windows and guide files',async()=>{
  const root=new URL('..',import.meta.url),tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
  const source=await readFile(new URL('../deploy/Dockerfile',import.meta.url),'utf8'),rules=(await readFile(new URL('../.dockerignore',import.meta.url),'utf8')).split(/\r?\n/).map(line=>line.trim()),required=new Set();
  const included=path=>{let keep=true;for(const rule of rules){if(!rule||rule.startsWith('#'))continue;const negated=rule.startsWith('!'),pattern=negated?rule.slice(1):rule;if(matchesGlob(path,pattern)||matchesGlob(path,pattern+'/**'))keep=negated;}return keep;};
  for(const line of source.split(/\r?\n/)){
    if(!/^COPY\s/.test(line)||/--from=/.test(line))continue;
    const tokens=line.trim().split(/\s+/).slice(1).filter(token=>!token.startsWith('--'));
    for(const input of tokens.slice(0,-1)){
      const files=tracked.filter(path=>matchesGlob(path,input)||path.startsWith(input+'/'));assert.ok(files.length,'Missing COPY source: '+input);
      for(const file of files){required.add(file);assert.ok(included(file),'COPY source excluded by .dockerignore: '+file);}
    }
  }
  for(const file of ['guide.mjs','docs/USER_GUIDE.md','deploy/install-client.ps1','scripts/build-client.mjs','package-lock.json'])assert.ok(required.has(file),file);
});
