import test from 'node:test';
import assert from 'node:assert/strict';
import {projectDirectoryListing,projectDirectoryEntries,projectDirectoryValue,projectDirectorySelection,projectCreationMachine} from '../dist/execution-ui.js';

const machines=[{id:'example-source-a'},{id:'example-source-b'}];

test('personal project directory binds each item to the requested authorized machine, including duplicate names',()=>{
  const directory=new Map([
    [machines[0].id,projectDirectoryListing({projects:[{project:'same-name',machine:'untrusted-node',environmentMode:'oci'},{project:'only-here'}],environmentModes:['shared','oci']})],
    [machines[1].id,projectDirectoryListing({projects:[{project:'same-name',environmentMode:'oci'}],environmentModes:['shared','oci']})],
    ['not-authorized',projectDirectoryListing({projects:[{project:'private'}],environmentModes:['oci']})]
  ]);
  const entries=projectDirectoryEntries(directory,machines);
  assert.equal(entries.length,3);
  assert.equal(entries[0].machine,machines[0].id);
  const values=entries.map(item=>projectDirectoryValue(item,entries));
  assert.equal(new Set(values).size,3);
  assert.equal(values[1],'only-here');
  assert.equal(projectDirectorySelection('same-name',entries),undefined,'an ambiguous bare name never chooses a source');
  assert.equal(projectDirectorySelection('same-name',entries,machines[1].id).machine,machines[1].id,'an already selected exact source retains the existing plain-name DOM contract');
  assert.notEqual(projectDirectoryValue(entries[0],entries,machines[1].id),'same-name','the other source stays explicitly qualified');
  for(const entry of entries)assert.equal(projectDirectorySelection(projectDirectoryValue(entry,entries),entries),entry);
  assert.equal(projectDirectorySelection(JSON.stringify(['not-authorized','private']),entries),undefined);
});

test('creating a personal container needs confirmed OCI admission and no topbar selection; legacy and shared modes remain explicit',()=>{
  const directory=new Map([
    [machines[0].id,projectDirectoryListing({projects:[]})],
    [machines[1].id,projectDirectoryListing({projects:[],environmentModes:['shared','isolated','oci']})]
  ]);
  assert.equal(projectCreationMachine('oci','','',directory,machines),machines[1].id);
  assert.equal(projectCreationMachine('oci',machines[0].id,'',directory,machines),machines[1].id,'a focused legacy host cannot make an OCI claim');
  assert.equal(projectCreationMachine('shared','','',directory,machines),'');
  assert.equal(projectCreationMachine('isolated','','',directory,machines),'');
  assert.equal(projectCreationMachine('shared',machines[0].id,'',directory,machines),machines[0].id);
  assert.equal(projectCreationMachine('oci','','',directory,[machines[0]]),'');
  assert.equal(projectCreationMachine('oci','','',directory,[]),'');
  directory.delete(machines[1].id);
  assert.equal(projectCreationMachine('oci','','',directory,machines),'','a failed read is not capability confirmation');
});

test('unconfirmed project lists are errors rather than empty directories or inferred container capabilities',()=>{
  for(const value of [undefined,null,{}, {projects:null},{projects:{}}])assert.throws(()=>projectDirectoryListing(value),/尚未确认/);
  assert.deepEqual(projectDirectoryListing({projects:[{project:'valid-name'},{project:'Invalid'},{project:'../elsewhere'},null]}),{projects:[{project:'valid-name'}],environmentModes:[]});
  assert.deepEqual(projectDirectoryListing({projects:[],environmentModes:'oci'}).environmentModes,[]);
});
