import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const cli=new URL('../cli.mjs',import.meta.url).pathname;
test('transfer options pass the common CLI gate but remain scoped to their action',()=>{
  const valid=[['copy','shared@'+'a'.repeat(64),'--from','gpu-1','--to','gpu-2','--name','data','--detach','--timeout','100'],['watch','invalid','--interval','2'],['list','--cursor','5','--limit','10']];
  for(const args of valid){const p=spawnSync(process.execPath,[cli,'transfer',...args,'--url','http://127.0.0.1:1','--session-file','/tmp/nonexistent-transfer-session']);assert.match(p.stderr.toString(),/先登录/);assert.doesNotMatch(p.stderr.toString(),/only valid|only for/);}
  for(const args of [['run','--from','gpu-1'],['transfer','upload','x','--detach'],['transfer','copy','x','--cwd','/tmp'],['run','--cursor','1']]){const p=spawnSync(process.execPath,[cli,...args]);assert.equal(p.status,1);assert.doesNotMatch(p.stderr.toString(),/先登录/);}
});
