import test from 'node:test';
import assert from 'node:assert/strict';
import {datasetIngressPolicy,datasetUploadAdmissionView} from '../dataset-ingress.mjs';

test('upload display exposes only the current trusted fixed warehouse target',()=>{
  const policy=datasetIngressPolicy({enabled:true,machine:'gpu-1',authority:'hdd',allowDuringMaintenance:true});
  assert.deepEqual(datasetUploadAdmissionView(policy),{protocol:1,available:true,targetMachine:'gpu-1'});
  assert.deepEqual(datasetUploadAdmissionView({...policy,machine:'gpu-4'}),{protocol:1,available:true,targetMachine:'gpu-4'});
  assert.deepEqual(Object.keys(datasetUploadAdmissionView(policy)).sort(),['available','protocol','targetMachine']);
  assert.deepEqual(datasetUploadAdmissionView({enabled:true,machine:'gpu-1',authority:'private-authority',token:'secret'}),
    {protocol:1,available:true,targetMachine:'gpu-1'});
});

test('disabled or unknown upload placement has no display target and is never guessed',()=>{
  for(const policy of [undefined,null,{enabled:false},{enabled:false,machine:'gpu-1'}])
    assert.deepEqual(datasetUploadAdmissionView(policy),{protocol:1,available:false,targetMachine:null});
  assert.deepEqual(datasetUploadAdmissionView({enabled:true,machine:'unknown'}),{protocol:1,available:true,targetMachine:null});
  assert.deepEqual(datasetUploadAdmissionView({enabled:true,machine:'not-in-inventory'}),{protocol:1,available:true,targetMachine:null});
});
