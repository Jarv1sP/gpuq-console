import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MACHINES} from '../dist/model.js';
import {installDatasetIngress,datasetUploadAdmissionView} from '../dataset-ingress.mjs';
import {executionCall} from '../execution.mjs';
import {archiveUploadCapability,archiveUploadSpecification,scanBrowserArchive,allocateDatasetUpload} from '../dist/dataset-upload.js';
import {scanLocalArchive} from '../client-data-upload.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex'),cap={protocol:1,formats:['zip','tar','tar.gz'],maxBytes:1024};
const spec={name:'sample',manifestBytes:123,manifestSha256:'a'.repeat(64),totalBytes:12,entries:1,archive:{protocol:1,fileName:'samples.tar.gz',format:'tar.gz',bytes:12,sha256:'b'.repeat(64)}};
function fixture(t){
 const db=new DatabaseSync(':memory:'),requested=MACHINES[0].id,storage=MACHINES.at(-1).id;
 const user={id:'demo-user-1',username:'member',role:'member',enabled:true,limits:{[requested]:1}};
 const principal={userId:user.id,username:user.username,role:user.role},calls=[],nodes=new Map();let declaration=cap;
 const service={db,store:{get:id=>id===user.id?structuredClone(user):null},audit(){},storageArchivePolicy:{enabled:true,machine:storage,authority:'hdd'},bridge:async(machine,operation,args)=>{
  calls.push({machine,operation,args});const node=nodes.get(args.uploadId);
  if(operation==='datasets.upload.routes')return {available:true,protocol:'dataset-upload-v1',machine,revision:'c'.repeat(64),certificateSha256:'d'.repeat(64),routes:[{id:'primary',kind:'campus-direct',endpoint:'https://warehouse.example'}],...(declaration?{archive:declaration}:{})};
  if(operation==='storage.upload.locate')return {protocol:'dataset-upload-location-v1',machine,userId:user.id,uploadId:args.uploadId,present:!!node,nodePresent:!!node,uploadAdmissionProtocol:1,initializationProtocol:1,authority:{enabled:true,machine,authority:'hdd'},...(node?{specification:node.specification,admissionProtocol:1,admissionKey:node.intentKey,requestedMachine:requested,storageMachine:storage,admissionAuthority:'hdd'}:{state:'NOT_INITIALIZED'})};
  if(operation==='storage.upload.admit'){assert.equal(args.hostAdmin,false);nodes.set(args.uploadId,args);return {uploadId:args.uploadId,...args.specification,state:'RECEIVING_MANIFEST',manifestOffset:0,chunkBytes:1024**2,admissionProtocol:1,admissionKey:args.intentKey,machine,authority:'hdd',uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true,routeSelection:true}};}
  if(operation==='datasets.upload.status')return {uploadId:args.uploadId,...node.specification,state:'UPLOADING',manifestOffset:node.specification.manifestBytes,chunkBytes:1024**2,archivePhase:'UPLOADING'};
  if(operation==='datasets.upload.direct-ticket')return {available:true,kind:'campus-direct',machine};
  throw Error(operation);
 }};
 installDatasetIngress(service,{enabled:true,machine:storage,authority:'hdd'});t.after(()=>db.close());
 return {db,service,calls,user,nodes,setCap:value=>declaration=value,call:(action,args={})=>executionCall(service,principal,'datasets.upload.'+action,{machine:requested,...args})};
}
test('only a real node archive declaration opens admission metadata; bad capabilities stay closed',async t=>{
 const f=fixture(t);assert.equal(datasetUploadAdmissionView(f.service.datasetIngressPolicy,f.service.datasetArchiveCapability).archive,undefined);
 await f.call('routes');assert.deepEqual(datasetUploadAdmissionView(f.service.datasetIngressPolicy,f.service.datasetArchiveCapability).archive,cap);
 f.setCap(null);await f.call('routes');assert.equal(datasetUploadAdmissionView(f.service.datasetIngressPolicy,f.service.datasetArchiveCapability).archive,undefined);
 for(const value of [{protocol:2,formats:['zip'],maxBytes:100},{protocol:1,formats:['zip','exe'],maxBytes:100},{protocol:1,formats:['zip'],maxBytes:undefined}])assert.equal(archiveUploadCapability(value),null);
});
test('fresh single archive is immutable, owner-bound, and gets only a campus ticket',async t=>{
 const f=fixture(t),key=randomUUID();const receipt=await f.call('admission.create',{key,...spec});assert.notEqual(receipt.uploadId,key);assert.deepEqual(receipt.specification,spec);
 const begin=await f.call('begin',{key:receipt.uploadId,...spec});assert.equal(begin.storageTier,'hdd');assert.deepEqual(f.nodes.get(receipt.uploadId).specification,spec);
 const status=await f.call('status',{uploadId:receipt.uploadId});assert.equal(status.archivePhase,'UPLOADING');
 await f.call('direct-ticket',{uploadId:receipt.uploadId,routeId:'primary'});
 await assert.rejects(f.call('direct-ticket',{uploadId:receipt.uploadId,routeId:'tail'}),error=>error.code==='CAMPUS_ROUTE_UNAVAILABLE');
 await assert.rejects(f.call('admission.create',{key,...spec,archive:{...spec.archive,sha256:'f'.repeat(64)}}),/绑定另一份/);
 assert.equal(f.nodes.size,1);assert(f.calls.every(call=>call.args.userId===f.user.id&&(call.operation==='storage.upload.locate'?Object.keys(call.args).sort().join(',')==='uploadId,userId':call.args.hostAdmin===false)));
 f.user.enabled=false;await assert.rejects(f.call('status',{uploadId:receipt.uploadId}));
});
test('no archive capability, unsupported format and excessive bytes never allocate a node UUID',async t=>{
 const f=fixture(t);f.setCap(null);await assert.rejects(f.call('admission.create',{key:randomUUID(),...spec}),error=>error.code==='ARCHIVE_FORMAT_UNSUPPORTED');
 f.setCap({...cap,maxBytes:8});await assert.rejects(f.call('admission.create',{key:randomUUID(),...spec}),error=>error.code==='ARCHIVE_TOO_LARGE');
 for(const archive of [{...spec.archive,fileName:'../sample.tar.gz'},{...spec.archive,bytes:11},{...spec.archive,format:'tar'}])assert.equal(archiveUploadSpecification(archive,spec.totalBytes,spec.entries),false);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM dataset_upload_placements').get().n,0);assert.equal(f.nodes.size,0);
});
test('lost archive admission receipt queries the original intent and never replays create',async()=>{
 const values=new Map(),key=randomUUID(),calls=[],capability={protocol:1,available:true,archive:cap};
 const keyStore={setIntent:(key,value)=>values.set(key,structuredClone(value)),getIntent:key=>values.get(key)};
 const call=async(op,args)=>{calls.push({op,args});throw Error('lost receipt');};
 const args={call,keyStore,baseKey:key,userId:'demo-user-1',machine:MACHINES[0].id,specification:spec,capability};
 await assert.rejects(allocateDatasetUpload(args));await assert.rejects(allocateDatasetUpload(args));
 assert.equal(calls.filter(row=>row.op==='datasets.upload.admission.create').length,1);assert.equal(calls.filter(row=>row.op==='datasets.upload.admission.status').length,2);assert.deepEqual(values.get(key).specification.archive,spec.archive);
});
test('browser hashes exactly one compressed file, keeps tgz equivalent, and never scans a directory',async()=>{
 for(const name of ['data.zip','data.tar','data.tar.gz','data.tgz']){
  const file=new File(['archive'],name),scan=await scanBrowserArchive(file,cap);assert.equal(scan.entries,1);assert.equal(scan.paths.get(name),file);assert.equal(scan.archive.sha256,sha('archive'));assert.deepEqual(JSON.parse(await scan.manifest.text()).files,scan.files);
 }
 await assert.rejects(scanBrowserArchive(new File(['file'],'plain.txt'),cap));
 await assert.rejects(scanBrowserArchive(new File(['archive'],'data.zip'),null));
 await assert.rejects(scanBrowserArchive(new File(['archive'],'data.zip'),{...cap,maxBytes:2}));
});
test('CLI archive snapshot bounds reads, rejects links and detects changes before publication',async t=>{
 const root=await mkdtemp(join(tmpdir(),'archive-cli-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=join(root,'data.tar');await writeFile(file,'archive');
 const scan=await scanLocalArchive(file,cap);assert.equal(scan.entries,1);assert.equal(scan.archive.sha256,sha('archive'));const reader=await scan.openEntry(scan.files[0]);assert.equal((await reader.read(0)).toString(),'archive');await reader.verify();await reader.close();
 await symlink(file,join(root,'link.tar'));await assert.rejects(scanLocalArchive(join(root,'link.tar'),cap),/普通压缩包/);
 await writeFile(file,'changed');await assert.rejects(scan.verify(),/已改变/);await assert.rejects(scanLocalArchive(file,null),/尚未开通/);
});

test('declared archive mode refuses a new directory admission but keeps an older intent resumable',async t=>{
 const f=fixture(t),key=randomUUID(),{archive,...directory}=spec;
 const original=await f.call('admission.create',{key,...directory});
 await f.call('routes');
 await assert.rejects(f.call('admission.create',{key:randomUUID(),...directory}),error=>error.code==='ARCHIVE_FORMAT_UNSUPPORTED');
 const resumed=await f.call('admission.create',{key,...directory});assert.equal(resumed.uploadId,original.uploadId);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM dataset_upload_placements').get().n,1);
});
