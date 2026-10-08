import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptArchiveUpload,archiveUploadSelection,archiveUploadStatus} from '../dist/datasets-ui.js';

// Protocol metadata still does not prove a campus route or publication.
test('archive mode requires protocol 1 and explicitly supported formats',()=>{
  for(const admission of [null,{}, {archive:{}},{archive:{protocol:0,formats:['zip']}},{archive:{protocol:'1',formats:['zip']}},{archive:{protocol:1,formats:[]}},{archive:{protocol:1,formats:'zip'}},{archive:{protocol:1,formats:['exe',true]}}])assert.equal(adaptArchiveUpload(admission),null);
  const admission={archive:{protocol:1,formats:['zip','tar.gz','zip'],maxBytes:42}};
  assert.deepEqual(adaptArchiveUpload(admission),{formats:['zip','tar.gz','tgz'],maxBytes:42});
  assert.equal(admission.archive.formats.length,3,'The admission is never mutated');
  for(const maxBytes of [undefined,NaN,-1,'42',Infinity])assert.equal(adaptArchiveUpload({archive:{protocol:1,formats:['tar'],maxBytes}}),null,'Malformed limits never mean unlimited');
  assert.equal(adaptArchiveUpload({archive:{protocol:1,formats:['tar'],maxBytes:null}}).maxBytes,null);
  assert.equal(adaptArchiveUpload({archive:{protocol:1,formats:['zip'],maxBytes:0}}).maxBytes,0);
  assert.equal(adaptArchiveUpload({archive:{protocol:1,formats:['zip','unsupported'],maxBytes:42}}),null);

});

test('one advertised archive becomes one file with its complete extension removed',()=>{
  const cap={formats:['zip','tar','tar.gz','tgz'],maxBytes:100};
  for(const [filename,name] of [['data.zip','data'],['data.TAR','data'],['data.training.tar.gz','data.training'],['数据.tgz','数据']]){
    const file={name:filename,size:100,webkitRelativePath:''};
    assert.deepEqual(archiveUploadSelection([file],cap),{file,name,bytes:100});
  }
  const file={name:'data.zip',size:100};
  for(const files of [[],[file,file]])assert.throws(()=>archiveUploadSelection(files,cap),/一个压缩包/);
  assert.throws(()=>archiveUploadSelection([{...file,webkitRelativePath:'folder/data.zip'}],cap),/不接受文件夹/);
  for(const name of ['data.txt','data.zip.exe','data.gz'])assert.throws(()=>archiveUploadSelection([{...file,name}],cap),/支持的压缩包/);
  assert.equal(archiveUploadSelection([{...file,name:'data.tgz'}],{formats:['tar.gz'],maxBytes:null}).name,'data','tgz is the advertised tar.gz format');
  for(const size of [101,-1,NaN,Infinity])assert.throws(()=>archiveUploadSelection([{...file,size}],cap),/过大/);
  assert.throws(()=>archiveUploadSelection([{...file,name:'.zip'}],cap),/名称不能为空/);
  assert.throws(()=>archiveUploadSelection([file],null),/一个压缩包/);
});

test('draft phases use real progress only and preserve unknown phases verbatim',()=>{
  for(const [phase,text] of [['UPLOADING','上传中'],['EXTRACTING','解压中'],['VERIFYING','校验中'],['READY','已入库'],['QUEUED','QUEUED'],['toString','toString']])assert.deepEqual(archiveUploadStatus({phase}),{text,paused:false});
  assert.equal(archiveUploadStatus({phase:'UPLOADING'},{percent:37.8}).text,'上传中 37%');
  for(const percent of [null,undefined,NaN,Infinity,-1,101,'30'])assert.equal(archiveUploadStatus({phase:'UPLOADING'},{percent}).text,'上传中');
  assert.equal(archiveUploadStatus({phase:'VERIFYING'},{percent:80}).text,'校验中');
  assert.equal(archiveUploadStatus(null).text,'未知');
});

test('only draft reason codes are mapped; campus outage pauses without success',()=>{
  const mapped={ARCHIVE_FORMAT_UNSUPPORTED:'压缩包格式不支持',ARCHIVE_UNSAFE_PATH:'压缩包包含不安全路径',ARCHIVE_TOO_LARGE:'压缩包过大',ARCHIVE_CORRUPT:'压缩包损坏',CAMPUS_ROUTE_UNAVAILABLE:'已暂停 · 校内网络恢复后继续'};
  for(const [reasonCode,text] of Object.entries(mapped))assert.deepEqual(archiveUploadStatus({phase:'FAILED',reasonCode}),{text,paused:reasonCode==='CAMPUS_ROUTE_UNAVAILABLE'});
  assert.equal(archiveUploadStatus({phase:'FAILED',reasonCode:'NEW_REASON'}).text,'NEW_REASON');
  assert.equal(archiveUploadStatus({phase:'FAILED',reasonCode:'NEW_REASON',reason:'后端原文'}).text,'后端原文');
  assert.equal(archiveUploadStatus({phase:'FAILED',reasonCode:'toString'}).text,'toString');
});
