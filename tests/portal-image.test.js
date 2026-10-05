// Validate the final runtime stage, independently of the builder's broad COPY.
// Node tests use an isolated Portal; the Dockerfile also loads the module graph
// inside the actual image without opening a database or starting a server.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join,posix,matchesGlob} from 'node:path';
import net from 'node:net';
import {build} from 'esbuild';
import {createPortalServer} from '../portal-server.mjs';
import {STARBASE_ASSETS} from '../frontend-assets.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
async function importGraph(entry,platform){
  const result=await build({absWorkingDir:root,entryPoints:[entry],bundle:true,
    platform,format:'esm',packages:'external',write:false,metafile:true,logLevel:'silent'});
  return Object.keys(result.metafile.inputs).map(file=>file.replaceAll('\\','/'));
}
async function imageLayout(){
  const source=await readFile(new URL('../deploy/Dockerfile',import.meta.url),'utf8');
  const runtime=source.replace(/\\\r?\n/g,' ').split(/^FROM\s+[^\n]+$/mi).at(-1);
  const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean),files=new Map();
  for(const line of runtime.split(/\r?\n/)){
    if(!/^\s*COPY\s/i.test(line)||/--from(?:=|\s)/.test(line))continue;
    const args=line.trim().replace(/^COPY\s+/i,'').replace(/^(?:--\S+\s+)+/,'');
    const tokens=args.startsWith('[')?JSON.parse(args):args.split(/\s+/),destination=tokens.at(-1),inputs=tokens.slice(0,-1);
    for(const input of inputs){
      const directory=tracked.some(file=>file.startsWith(input+'/'));
      const matches=tracked.filter(file=>matchesGlob(file,input)||directory&&file.startsWith(input+'/'));
      assert.ok(matches.length,'Missing runtime COPY source: '+input);
      for(const file of matches){
        const target=directory?posix.join(destination,file.slice(input.length+1)):
          inputs.length>1||destination==='.'||destination.endsWith('/')?posix.join(destination,posix.basename(file)):destination;
        files.set(posix.normalize(target),file);
      }
    }
  }
  return files;
}
function staticFile(value,base='index.html'){
  const url=new URL(value,'http://runtime.fixture/'+base);
  return url.origin==='http://runtime.fixture'&&/\.(?:js|css|woff2|png|svg|ico)$/.test(url.pathname)?url.pathname.slice(1):null;
}

test('every transitive local Portal module exists at its runtime COPY path',async t=>{
  const graph=await importGraph('portal-server.mjs','node'),files=await imageLayout();
  const modules=graph.filter(file=>file.endsWith('.mjs'));
  assert.ok(modules.includes('frontend-assets.mjs'));
  assert.ok(modules.includes('native-task-metadata.mjs'),'follow imports beyond the entry point');
  for(const file of graph)assert.equal(files.get(file),file,'Runtime image is missing imported module: '+file);
  t.diagnostic('Runtime COPY covers '+modules.length+' local .mjs modules and their local JS dependencies.');
});

test('public login static module graph never imports the inventory',async()=>{
  const result=await build({absWorkingDir:root,entryPoints:['dist/app.js'],bundle:true,
    platform:'browser',format:'esm',write:false,metafile:true,logLevel:'silent'});
  const seen=new Set(),pending=['dist/app.js'];
  while(pending.length){
    const file=pending.pop();if(seen.has(file))continue;seen.add(file);
    assert.notEqual(file,'dist/machines.js','Private inventory must not enter the public static module graph');
    for(const item of result.metafile.inputs[file].imports)if(item.kind==='import-statement'&&!item.external)pending.push(item.path);
  }
  assert.ok(seen.has('dist/client.js')&&seen.has('dist/resources-ui.js'));
  assert.ok(!seen.has('dist/service.js'),'The preview service is loaded only in demo mode');
});

test('client imports, styles and fonts are copied and served by the Portal whitelist',async t=>{
  const graph=await importGraph('dist/app.js','browser'),files=await imageLayout();
  for(const file of graph)assert.equal(files.get(file),file,'Runtime image is missing client dependency: '+file);
  // The existing preview-only service is deliberately unavailable in Portal.
  // /runtime.js selects remote production mode before the client is created.
  const assets=new Set([...graph.filter(file=>file!=='dist/service.js').map(file=>file.replace(/^dist\//,'')),...Object.values(STARBASE_ASSETS)]);
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  for(const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)){const file=staticFile(match[1]);if(file)assets.add(file);}
  for(const file of assets)if(file.endsWith('.css')){
    const css=await readFile(join(root,'dist',file),'utf8');
    for(const match of css.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)){const asset=staticFile(match[1],file);if(asset)assets.add(asset);}
  }
  assert.ok(assets.has('control-ui.js')&&assets.has('vendor/fonts/Archivo-Variable.woff2'));
  for(const file of assets)assert.equal(files.get('dist/'+file),'dist/'+file,'Runtime image is missing static asset: '+file);
  const directory=await mkdtemp(join(tmpdir(),'gpuq-portal-image-'));let server;
  t.after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(directory,{recursive:true,force:true});});
  const bootstrap=join(directory,'bootstrap.json');await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Local-Image-Asset-Fixture-Only-2026!'}),{mode:0o600});
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port,origin='http://127.0.0.1:'+port;await new Promise(resolve=>reservation.close(resolve));
  ({server}=await createPortalServer({database:join(directory,'portal.sqlite'),bootstrap,origin,secure:false}));
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const runtime=await fetch(origin+'/runtime.js');assert.equal(runtime.status,200);
  assert.match(await runtime.text(),/globalThis\.GPUQ_LOCAL_API=true;globalThis\.GPUQ_PRODUCTION=true;/);
  for(const page of ['/','/guide','/guide/data']){
    const response=await fetch(origin+page);assert.equal(response.status,200);const html=await response.text();
    assert.match(html,/href="\/favicon\.svg\?v=stargate-2"/);
    assert.match(html,/href="\/favicon\.ico\?v=stargate-2"/);
    assert.match(html,/rel="mask-icon"[^>]*href="\/mask-icon\.svg\?v=stargate-2"[^>]*color="#0A0B0D"/);
    assert.match(html,/rel="apple-touch-icon"[^>]*href="\/apple-touch-icon\.png\?v=stargate-2"/);
    assert.match(html,/<meta name="theme-color" content="#0A0B0D"/);
  }
  for(const [file,type] of [['favicon.svg','image/svg+xml'],['favicon.ico','image/x-icon'],['mask-icon.svg','image/svg+xml']])for(const suffix of ['','?v=stargate-2'])for(const method of ['GET','HEAD']){
    const response=await fetch(origin+'/'+file+suffix,{method});assert.equal(response.status,200,'anonymous icon '+method+' '+file);
    assert.equal(response.headers.get('content-type'),type);const content=Buffer.from(await response.arrayBuffer());
    if(method==='HEAD'){assert.equal(content.length,0);continue;}
    if(file==='favicon.ico'){
      assert.equal(content.readUInt16LE(0),0);assert.equal(content.readUInt16LE(2),1);assert.equal(content.readUInt16LE(4),3);
      for(const [index,size] of [16,32,48].entries()){
        const pos=6+16*index;assert.equal(content[pos],size);assert.equal(content[pos+1],size);
        const length=content.readUInt32LE(pos+8),offset=content.readUInt32LE(pos+12),png=content.subarray(offset,offset+length);
        assert.equal(png.length,length);assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
        assert.equal(png.readUInt32BE(16),size);assert.equal(png.readUInt32BE(20),size);
      }
    }else{assert.match(content.toString(),/M10\.41 71\.20 L42\.06 8\.00/);if(file==='mask-icon.svg')assert.doesNotMatch(content.toString(),/<rect/);}
  }
  const login=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'admin',password:'Local-Image-Asset-Fixture-Only-2026!',client:'browser'})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  for(const file of assets){
    if(file==='machines.js'){
      const anonymous=await fetch(origin+'/'+file);assert.equal(anonymous.status,401);assert.equal(await anonymous.text(),'');
    }
    const response=await fetch(origin+'/'+file,file==='machines.js'?{headers:{Cookie:cookie}}:{});
    assert.equal(response.status,200,'Static whitelist is missing /'+file);
    const type=file.endsWith('.svg')?'image/svg+xml':file.endsWith('.ico')?'image/x-icon':file.endsWith('.png')?'image/png':file.endsWith('.woff2')?'font/woff2':file.endsWith('.css')?'text/css':'text/javascript';
    assert.ok(response.headers.get('content-type')?.startsWith(type),'Incorrect asset MIME: '+file);
    const content=Buffer.from(await response.arrayBuffer());
    assert.ok(content.byteLength>0,'Empty asset: '+file);
    if(file==='apple-touch-icon.png'){
      assert.equal(content.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      assert.equal(content.readUInt32BE(16),180);assert.equal(content.readUInt32BE(20),180);
    }
  }
  t.diagnostic('Runtime COPY and HTTP whitelist cover '+assets.size+' client assets, including all self-hosted fonts.');
});
