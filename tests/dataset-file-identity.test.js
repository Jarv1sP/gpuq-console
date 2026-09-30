import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import vm from 'node:vm';

// Exercise the standalone CLI's implementation without running its main entry
// point or depending on a live service/account. Inject only filesystem views.
const cliSource=await fs.readFile(new URL('../cli.mjs',import.meta.url),'utf8');
const source=cliSource.slice(cliSource.indexOf('function sameDatasetFile('),cliSource.indexOf('async function secret('));
function client({platform=process.platform,lstat=fs.lstat,open=fs.open}={}){
  return vm.runInNewContext(source+'\n({sameDatasetFile,scanLocalDataset,uploadLocalDataset})',{
    Buffer,Map,Number,BigInt,JSON,process:{platform},lstat,open,readdir:fs.readdir,
    basename,join,resolve,createHash,randomUUID,fsConstants,setTimeout,
    DATA_CHUNK:1024*1024,DATA_MANIFEST_LIMIT:64*1024*1024,DATA_ENTRY_LIMIT:500000,
    fail:message=>{throw Error(message);},
  });
}
const hash=data=>createHash('sha256').update(data).digest('hex');
const copy=(stat,changes)=>Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,changes);
const windowsLstat=async(...args)=>copy(await fs.lstat(...args),{dev:0n});

async function fixture(t){
  const directory=await fs.mkdtemp(join(tmpdir(),'gpuq-data-identity-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.mkdir(join(directory,'images'));
  const filename=join(directory,'images','00001.jpg');await fs.writeFile(filename,'temporary image bytes');
  await fs.writeFile(join(directory,'empty'),'');await fs.mkdir(join(directory,'empty-directory'));
  const calls=[],uploaded=new Map();let manifest=Buffer.alloc(0),parsed;
  const state={uploadId:'test-upload',state:'RECEIVING_MANIFEST',manifestOffset:0};
  const hooks={};
  const call=async(operation,args)=>{
    const action=operation.split('.').at(-1);calls.push(action);
    await hooks[action]?.(args);
    if(action==='begin')return {result:{...state}};
    if(action==='manifest'){
      assert.equal(args.offset,manifest.length);manifest=Buffer.concat([manifest,Buffer.from(args.data,'base64')]);
      return {result:{offset:manifest.length}};
    }
    if(action==='seal'){parsed=JSON.parse(manifest);state.state='UPLOADING';return {result:{...state}};}
    if(action==='status')return {result:{...state,file:{...parsed.files.find(file=>file.path===args.path),offset:0,complete:false}}};
    if(action==='chunk'){
      const bytes=Buffer.from(args.data,'base64'),before=uploaded.get(args.path)||Buffer.alloc(0);
      assert.equal(args.offset,before.length);uploaded.set(args.path,Buffer.concat([before,bytes]));
      return {result:{offset:before.length+bytes.length,complete:true}};
    }
    if(action==='commit'){
      for(const file of parsed.files)assert.equal(hash(uploaded.get(file.path)),file.sha256);
      return {result:{...state,state:'READY',dataset:'test-data',version:hash(manifest)}};
    }
    throw Error('Unexpected mock operation '+operation);
  };
  const upload=api=>api.uploadLocalDataset(call,{machine:'test-machine',name:'sample',userId:'test-only',directory,progress(){},keyStore:new Map()});
  return {directory,filename,calls,hooks,upload};
}

test('Windows unknown/64-bit path device compatibility is limited to path-to-handle checks',()=>{
  const win=client({platform:'win32'}),posix=client({platform:'linux'});
  const base={dev:123n,ino:23362423068501911n,mode:0o100644n,size:21n,mtimeNs:1790768942140231200n,ctimeNs:1790768942140231200n,nlink:1n};
  for(const dev of [0n,(17n<<32n)|123n]){
    const path={...base,dev};
    assert.equal(win.sameDatasetFile(path,base,{pathToHandle:true}),true);
    assert.equal(win.sameDatasetFile(path,base),false,'never loosen handle/handle or path/path comparisons');
    assert.equal(posix.sameDatasetFile(path,base,{pathToHandle:true}),false);
  }
  assert.equal(win.sameDatasetFile({...base,dev:124n},base,{pathToHandle:true}),false);
  for(const field of ['ino','mode','size','mtimeNs','ctimeNs','nlink']){
    assert.equal(win.sameDatasetFile({...base,dev:0n},{...base,[field]:base[field]+1n},{pathToHandle:true}),false,field);
  }
  assert.equal(Number(base.ino),Number(base.ino+1n),'fixture deliberately covers a rounded numeric inode collision');
});

test('unchanged native dataset uploads and verifies hashes with bigint metadata',async t=>{
  const f=await fixture(t),result=await f.upload(client());assert.equal(result.state,'READY');assert.ok(f.calls.includes('commit'));
});

test('old Windows dev=0 path stats upload first image, empty files and directories without false positives',async t=>{
  const f=await fixture(t),result=await f.upload(client({platform:'win32',lstat:windowsLstat}));
  assert.equal(result.state,'READY');assert.ok(f.calls.includes('commit'));
});

test('Windows compatibility still rejects a changed descriptor before hashing',async t=>{
  const f=await fixture(t),open=async(...args)=>{
    const handle=await fs.open(...args);return {close:()=>handle.close(),read:(...a)=>handle.read(...a),stat:async(...a)=>copy(await handle.stat(...a),{ino:1n})};
  };
  await assert.rejects(f.upload(client({platform:'win32',lstat:windowsLstat,open})),/changed before hashing/);
  assert.equal(f.calls.length,0);
});

test('Windows compatibility retains strict descriptor identity during hashing',async t=>{
  const f=await fixture(t),open=async(...args)=>{
    const handle=await fs.open(...args);let reads=0;
    return {close:()=>handle.close(),read:async(...a)=>{reads++;return handle.read(...a);},stat:async(...a)=>{const st=await handle.stat(...a);return reads?copy(st,{dev:st.dev+1n}):st;}};
  };
  await assert.rejects(f.upload(client({platform:'win32',lstat:windowsLstat,open})),/changed during hashing/);
  assert.equal(f.calls.length,0);
});

test('Windows compatibility retains the original descriptor device when reopening for upload',async t=>{
  const f=await fixture(t),counts=new Map(),open=async(...args)=>{
    const handle=await fs.open(...args),count=(counts.get(args[0])||0)+1;counts.set(args[0],count);
    return {close:()=>handle.close(),read:(...a)=>handle.read(...a),stat:async(...a)=>{const st=await handle.stat(...a);return count>1?copy(st,{dev:st.dev+1n}):st;}};
  };
  await assert.rejects(f.upload(client({platform:'win32',lstat:windowsLstat,open})),/changed after hashing/);
  assert.equal(f.calls.includes('commit'),false);
});

test('Windows compatibility refuses content changes and file replacements after hashing',async t=>{
  for(const replace of [false,true])await t.test(replace?'replacement':'same-size edit',async t=>{
    const f=await fixture(t);
    f.hooks.begin=async()=>{if(replace){const replacement=join(f.directory,'replacement');await fs.writeFile(replacement,'temporary image bytes');await fs.rename(replacement,f.filename);}else await fs.writeFile(f.filename,'changed image bytes!!');};
    await assert.rejects(f.upload(client({platform:'win32',lstat:windowsLstat})),/changed after hashing/);
    assert.equal(f.calls.includes('commit'),false);
  });
});

test('Windows compatibility refuses edits and directory changes during upload before commit',async t=>{
  for(const directoryEdit of [false,true])await t.test(directoryEdit?'directory edit':'file edit',async t=>{
    const f=await fixture(t);let changed=false;
    f.hooks.chunk=async args=>{if(changed||args.path!=='images/00001.jpg')return;changed=true;if(directoryEdit)await fs.writeFile(join(f.directory,'new-file'),'extra');else await fs.writeFile(f.filename,'changed during upload');};
    await assert.rejects(f.upload(client({platform:'win32',lstat:windowsLstat})),/changed/);
    assert.equal(f.calls.includes('commit'),false);
  });
});

test('Windows compatibility rechecks previously uploaded files before commit',async t=>{
  const f=await fixture(t);await fs.writeFile(join(f.directory,'z-last'),'last');
  f.hooks.chunk=async args=>{if(args.path==='z-last')await fs.writeFile(f.filename,'changed after upload!');};
  await assert.rejects(f.upload(client({platform:'win32',lstat:windowsLstat})),/Local file changed; no publication/);
  assert.equal(f.calls.includes('commit'),false);
});

test('Windows compatibility still refuses hard links and symbolic-link metadata',async t=>{
  for(const symlink of [false,true])await t.test(symlink?'symlink':'hard link',async t=>{
    const f=await fixture(t),lstat=async(...args)=>{
      const st=await windowsLstat(...args);return args[0]===f.filename?copy(st,symlink?{mode:0o120777n}:{nlink:2n}):st;
    };
    await assert.rejects(f.upload(client({platform:'win32',lstat})),symlink?/Symlink/:/single-link/);
    assert.equal(f.calls.length,0);
  });
});
