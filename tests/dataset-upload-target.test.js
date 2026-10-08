import test from 'node:test';
import assert from 'node:assert/strict';
import {datasetUploadAdmissionView} from '../dataset-ingress.mjs';

test('upload display exposes only the current trusted fixed warehouse target',()=>{
  const value=datasetUploadAdmissionView({enabled:true,machine:'gpu-1',authority:'private-authority',token:'secret'});
  assert.deepEqual(value,{protocol:1,available:true,targetMachine:'gpu-1'});
});

test('disabled or unknown upload placement has no display target and is never guessed',()=>{
  assert.deepEqual(datasetUploadAdmissionView({enabled:false,machine:'gpu-1'}),{protocol:1,available:false,targetMachine:null});
  assert.deepEqual(datasetUploadAdmissionView(),{protocol:1,available:false,targetMachine:null});
  assert.deepEqual(datasetUploadAdmissionView({enabled:true,machine:'not-in-inventory'}),{protocol:1,available:true,targetMachine:null});
});
