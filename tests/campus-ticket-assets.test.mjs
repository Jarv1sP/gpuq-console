import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {createPortalServer} from '../portal-server.mjs';

test('browser ticket validator imports resolve through the actual Portal HTTP asset route',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'campus-ticket-assets-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Local-Campus-Ticket-Fixture-2026'}));
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false});
  clearInterval(service.executionTimer);
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const asset=await fetch(origin+'/campus-ticket-time.js');
  assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/^text\/javascript/);
  assert.equal(await asset.text(),await readFile(new URL('../dist/campus-ticket-time.js',import.meta.url),'utf8'));
  const consumer=await fetch(origin+'/dataset-upload.js');
  assert.equal(consumer.status,200);assert.match(await consumer.text(),/from '\.\/campus-ticket-time\.js'/);
});
