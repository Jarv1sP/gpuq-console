import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createLocalDatasetTools,scanLocalDataset} from '../client-data-upload.mjs';
import {campusTLSFixture} from './campus-upload-fixture.mjs';

// Exercise the shared local reader used by upload and Git sync. Only filesystem
// views/platform are injected; transport and identity checks execute unchanged.
function client({platform=process.platform,lstat=fs.lstat,open=fs.open,readdir=fs.readdir}={}){
  return createLocalDatasetTools({platform,lstat,open,readdir});
}
const hash=data=>createHash('sha256').update(data).digest('hex');
const copy=(stat,changes)=>Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,changes);
const windowsLstat=async(...args)=>copy(await fs.lstat(...args),{dev:0n});

// NTFS can coalesce metadata timestamps for back-to-back same-size writes.
// These cases exercise the metadata-change guard, not the server hash guard,
// so give the edit a distinct timestamp without adding a timing-dependent sleep.
async function changeFile(filename,bytes){
  const before=await fs.stat(filename,{bigint:true});await fs.writeFile(filename,bytes);
  await fs.utimes(filename,before.atime,new Date(Number(before.mtimeMs)+2000));
  assert.notEqual((await fs.stat(filename,{bigint:true})).mtimeNs,before.mtimeNs);
}

async function fixture(t){
  const directory=await fs.mkdtemp(join(tmpdir(),'gpuq-data-identity-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.mkdir(join(directory,'images'));
  const filename=join(directory,'images','00001.jpg');await fs.writeFile(filename,'temporary image bytes');
  await fs.writeFile(join(directory,'empty'),'');await fs.mkdir(join(directory,'empty-directory'));
  const calls=[],uploaded=new Map();let manifest=Buffer.alloc(0),parsed;
  const state={uploadId:'33333333-3333-4333-8333-333333333333',state:'RECEIVING_MANIFEST',manifestOffset:0};
  const hooks={};
  const call=async(operation,args)=>{
    const action=operation.split('.').at(-1);calls.push(action);
    await hooks[action]?.(args);
    if(action==='begin')return {result:{...state,uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true}}};
    if(action==='direct-ticket')return {result:tls.grant()};
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
  const tls=await campusTLSFixture(async(req,res)=>{try{let raw='';for await(const bytes of req)raw+=bytes;const {operation,args}=JSON.parse(raw);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await call(operation,args)));}catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}},{machine:'test-machine'});
  t.after(async()=>{await tls.close();assert.equal(tls.counters.portalFileRequests,0);});
  const upload=api=>api.uploadLocalDataset(call,{machine:'test-machine',name:'sample',userId:'test-only',directory,progress(){},keyStore:{get:()=>state.uploadId}});
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
    f.hooks.begin=async()=>{if(replace){const replacement=join(f.directory,'replacement');await fs.writeFile(replacement,'temporary image bytes');await fs.rename(replacement,f.filename);}else await changeFile(f.filename,'changed image bytes!!');};
    await assert.rejects(f.upload(client({platform:'win32',lstat:windowsLstat})),/changed after hashing/);
    assert.equal(f.calls.includes('commit'),false);
  });
});

test('Windows compatibility refuses edits and directory changes during upload before commit',async t=>{
  for(const directoryEdit of [false,true])await t.test(directoryEdit?'directory edit':'file edit',async t=>{
    const f=await fixture(t);let changed=false;
    f.hooks.chunk=async args=>{if(changed||args.path!=='images/00001.jpg')return;changed=true;if(directoryEdit)await fs.writeFile(join(f.directory,'new-file'),'extra');else await changeFile(f.filename,'changed during upload');};
    await assert.rejects(f.upload(client({platform:'win32',lstat:windowsLstat})),/changed/);
    assert.equal(f.calls.includes('commit'),false);
  });
});

test('Windows compatibility rechecks previously uploaded files before commit',async t=>{
  const f=await fixture(t);await fs.writeFile(join(f.directory,'z-last'),'last');
  f.hooks.chunk=async args=>{if(args.path==='z-last')await changeFile(f.filename,'changed after upload!');};
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

async function coalescedDirectories(root){
  const frozen=new Map();
  async function visit(folder){
    frozen.set(folder,copy(await fs.lstat(folder,{bigint:true}),{dev:0n}));
    for(const name of await fs.readdir(folder)){
      const path=join(folder,name);if((await fs.lstat(path)).isDirectory())await visit(path);
    }
  }
  await visit(root);
  // Only directory metadata is frozen. Real file identities and real readdir
  // calls still run, so namespace edits cannot rely on a distinct timestamp.
  return async(...args)=>frozen.get(args[0])||windowsLstat(...args);
}

test('coalesced Windows directory metadata retains unchanged uploads',async t=>{
  const f=await fixture(t),lstat=await coalescedDirectories(f.directory);
  assert.equal((await f.upload(client({platform:'win32',lstat}))).state,'READY');
  assert.ok(f.calls.includes('commit'));
});

test('coalesced directory metadata rejects real namespace changes before commit',async t=>{
  for(const change of ['root-add','nested-add','empty-remove','empty-rename'])await t.test(change,async t=>{
    const f=await fixture(t),lstat=await coalescedDirectories(f.directory);let changed=false;
    const empty=join(f.directory,'empty-directory');
    f.hooks.chunk=async args=>{
      if(changed||args.path!=='images/00001.jpg')return;changed=true;
      if(change==='root-add')await fs.writeFile(join(f.directory,'new-file'),'extra');
      if(change==='nested-add')await fs.writeFile(join(f.directory,'images','new-file'),'extra');
      if(change==='empty-remove')await fs.rmdir(empty);
      if(change==='empty-rename')await fs.rename(empty,join(f.directory,'renamed-empty'));
    };
    await assert.rejects(f.upload(client({platform:'win32',lstat})),/Local directory changed; no publication was requested/);
    assert.equal(changed,true);assert.equal(f.calls.includes('commit'),false);
  });
});

test('coalesced directory metadata rejects a new entry during hashing before any server call',async t=>{
  const f=await fixture(t),lstat=await coalescedDirectories(f.directory);let changed=false;
  const open=async(...args)=>{
    const handle=await fs.open(...args);
    return {close:()=>handle.close(),stat:(...a)=>handle.stat(...a),read:async(...a)=>{
      const result=await handle.read(...a);
      if(!changed&&args[0]===f.filename){changed=true;await fs.writeFile(join(f.directory,'images','new-file'),'extra');}
      return result;
    }};
  };
  await assert.rejects(f.upload(client({platform:'win32',lstat,open})),/Local directory changed during scan/);
  assert.equal(changed,true);assert.equal(f.calls.length,0);
});

test('directory verification keeps stat checks on both sides of namespace reads',async t=>{
  for(const phase of ['before','after'])await t.test(phase,async t=>{
    const f=await fixture(t);let verifying=false,edited=false,namespaceReads=0;
    const filesystem={open:fs.open,lstat:async(...args)=>{
      const st=await fs.lstat(...args);return edited&&args[0]===f.directory?copy(st,{ino:st.ino+1n}):st;
    },readdir:async folder=>{
      const names=await fs.readdir(folder);
      if(verifying&&folder===f.directory){namespaceReads++;if(phase==='after')edited=true;}
      return names;
    }};
    const snapshot=await scanLocalDataset(f.directory,()=>{},filesystem);
    verifying=true;if(phase==='before')edited=true;
    await assert.rejects(snapshot.verify(),/Local directory changed; no publication/);
    assert.equal(namespaceReads,phase==='before'?0:1);
  });
});
