import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultDatasetDisplayName} from '../dist/dataset-display-name.js';

test('only exact personal upload/workspace IDs yield their original user-entered name',()=>{
  for(const prefix of ['u','w'])for(const name of ['ZJU-MoCap','4ddress','train_19','a'.repeat(40)]){
    const dataset=prefix+'-0123456789abcdef-'+name;
    assert.equal(defaultDatasetDisplayName(dataset),name);
    assert.equal(dataset,prefix+'-0123456789abcdef-'+name,'The immutable ID is untouched');
  }
});

test('lookalikes, malformed namespace and non-generated dataset IDs remain exact',()=>{
  for(const dataset of ['zjumocap','u-guessed-owner-data','w-user-private','u-0123456789abcde-ZJU',
    'u-0123456789abcdef0-ZJU','u-0123456789ABCDEF-ZJU','r-0123456789abcdef-ZJU',
    'u-0123456789abcdef-','u-0123456789abcdef-_data','u-0123456789abcdef-'+'a'.repeat(41),
    'u-0123456789abcdef-中文','u-0123456789abcdef-train/path','u-0123456789abcdef-data\n'])
    assert.equal(defaultDatasetDisplayName(dataset),dataset);
  for(const value of [null,undefined,{},123])assert.throws(()=>defaultDatasetDisplayName(value),TypeError);
});
