"""Small isolated project upload fixtures; no remote data or services."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import uuid

spec=importlib.util.spec_from_file_location('project_security',Path(__file__).with_name('project-security.test.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)


class UploadRecovery(base.ProjectSecurity):
    def request(self, data=b'abcd', **extra):
        return {**self.args,'path':'train.py','uploadId':str(uuid.uuid4()),'totalSize':len(data),
                'sha256':hashlib.sha256(data).hexdigest(),**extra}

    def put(self, request, data, offset, final=False):
        return self.node.process('files.put',{**request,'offset':offset,'final':final,'data':base64.b64encode(data).decode()})

    def status(self, request):
        return self.node.process('files.upload.status',request)

    def test_chunk_and_final_ack_loss_resume_same_identity_without_duplication(self):
        r=self.request();self.put(r,b'ab',0);self.put(r,b'ab',0)
        value=self.status(r);self.assertEqual((value['state'],value['receivedBytes'],value['uploadId']),('UPLOADING',2,r['uploadId']))
        final=self.put(r,b'cd',2,True);again=self.put(r,b'cd',2,True)
        self.assertTrue(final['complete'] and again['complete'])
        self.assertEqual(self.status(r)['state'],'COMPLETE')
        self.assertFalse(self.status(r)['completionPending'])
        self.assertEqual(self.ops.store.dev_paths(*self.ops.identity(self.args))['code'].joinpath('train.py').read_bytes(),b'abcd')

    def test_readonly_discovery_recovers_original_id_and_offset(self):
        r=self.request();self.put(r,b'ab',0)
        value=self.status({k:v for k,v in r.items() if k!='uploadId'})
        self.assertEqual(value['uploadId'],r['uploadId']);self.assertEqual(value['receivedBytes'],2)
        self.assertEqual(self.status({**r,'uploadId':str(uuid.uuid4())})['state'],'CONFLICT')

    def test_final_rename_before_receipt_recovers_without_rewriting_target(self):
        r=self.request();original=self.node.atomic_json
        def fail_receipt(path,value):
            if str(path).endswith('.done'):raise OSError('synthetic lost completion receipt')
            return original(path,value)
        with patch.object(self.node,'atomic_json',side_effect=fail_receipt):
            with self.assertRaisesRegex(OSError,'synthetic'):self.put(r,b'abcd',0,True)
        target=self.ops.store.dev_paths(*self.ops.identity(self.args))['code']/'train.py';stamp=target.stat()
        before={p.name:p.read_bytes() for p in self.ops.transfer_dir(self.args).iterdir() if p.is_file()}
        value=self.status(r);self.assertEqual(value['state'],'COMPLETE');self.assertTrue(value['completionPending'])
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.ops.transfer_dir(self.args).iterdir() if p.is_file()})
        final=self.put(r,b'',r['totalSize'],True)
        self.assertTrue(final['complete']);self.assertFalse(final['completionPending'])
        self.assertFalse(list(self.ops.transfer_dir(self.args).glob('*.json')))
        self.assertFalse(self.status(r)['completionPending'])
        self.assertEqual(stamp.st_ino,target.stat().st_ino);self.assertEqual(stamp.st_mtime_ns,target.stat().st_mtime_ns)

    def test_interrupted_before_final_rename_resumes_zero_byte_commit(self):
        r=self.request();original=self.node.os.replace
        def fail_rename(source,target,*args,**kwargs):
            if str(source).endswith('.part'):raise OSError('synthetic rename interrupt')
            return original(source,target,*args,**kwargs)
        with patch.object(self.node.os,'replace',side_effect=fail_rename):
            with self.assertRaisesRegex(OSError,'rename interrupt'):self.put(r,b'abcd',0,True)
        state=self.status(r);self.assertEqual(state['receivedBytes'],4);self.assertTrue(state['resumable'])
        self.assertTrue(self.put(r,b'',4,True)['complete'])

    def test_completion_recovery_reads_target_hash_only_once(self):
        r=self.request();self.put(r,b'abcd',0,True)
        with patch.object(self.ops,'upload_target',wraps=self.ops.upload_target) as inspect:
            result=self.ops.upload({**r,'offset':0,'final':True,'data':base64.b64encode(b'abcd').decode()},self.ops.store.dev_paths(*self.ops.identity(self.args))['code'])
        self.assertTrue(result['complete']);self.assertEqual(sum(c.kwargs.get('digest') is True for c in inspect.call_args_list),1)

    def test_replaced_identity_never_claims_previous_staging_bytes(self):
        old=self.request();self.put(old,b'ab',0)
        new=self.request(b'newer');original=self.node.atomic_json
        def fail_new_meta(path,value):
            if isinstance(value,dict) and value.get('identity')=={k:new[k] for k in ('path','uploadId','totalSize','sha256')}:raise OSError('synthetic metadata failure')
            return original(path,value)
        with patch.object(self.node,'atomic_json',side_effect=fail_new_meta):
            with self.assertRaisesRegex(OSError,'metadata failure'):self.put(new,b'ne',0)
        self.assertNotEqual(self.status(new)['state'],'UPLOADING')
        self.assertEqual(self.status(old)['receivedBytes'],0)

    def test_external_edit_after_completion_never_overwritten_by_recovery(self):
        r=self.request();self.put(r,b'abcd',0,True)
        target=self.ops.store.dev_paths(*self.ops.identity(self.args))['code']/'train.py';target.write_bytes(b'user edit')
        self.assertEqual(self.status(r)['state'],'CONFLICT')
        with self.assertRaisesRegex(ValueError,'changed'):self.put(r,b'abcd',0,True)
        self.assertEqual(target.read_bytes(),b'user edit')

    def test_target_changed_during_upload_is_not_replaced(self):
        r=self.request();self.put(r,b'ab',0)
        target=self.ops.store.dev_paths(*self.ops.identity(self.args))['code']/'train.py';target.write_bytes(b'new code')
        self.assertEqual(self.status(r)['state'],'CONFLICT')
        with self.assertRaisesRegex(ValueError,'changed during'):self.put(r,b'cd',2,True)
        self.assertEqual(target.read_bytes(),b'new code')

    def test_completed_old_id_cannot_replace_a_new_inflight_upload(self):
        r=self.request();self.put(r,b'abcd',0,True)
        newer=self.request(b'newer');self.put(newer,b'ne',0)
        with self.assertRaisesRegex(ValueError,'changed'):self.put(r,b'abcd',0,True)
        self.assertEqual(self.status(newer)['receivedBytes'],2)

    def test_status_is_owner_project_bound_and_does_not_create_upload_staging(self):
        r=self.request();self.put(r,b'ab',0)
        other={**self.args,'userId':'demo-user-4'};self.node.process('projects.create',other)
        location=self.ops.folder/(self.ops.key(other)+'.uploads');self.assertFalse(location.exists())
        self.assertEqual(self.status({**r,**other})['state'],'ABSENT');self.assertFalse(location.exists())
        self.assertEqual(self.status(r)['receivedBytes'],2)

    def test_nonproject_output_and_injected_fields_are_rejected(self):
        r=self.request()
        for extra in ({'project':None},{'area':'output'},{'userId':'../bad'},{'path':'../bad'},{'offset':0},{'data':'payload'},{'hostAdmin':True}):
            with self.assertRaises((ValueError,FileNotFoundError)):self.status({**r,**extra})

    def test_complete_receipt_does_not_block_normal_publication(self):
        r=self.request();self.put(r,b'abcd',0,True)
        folder=self.ops.transfer_dir(self.args)
        self.assertFalse(list(folder.glob('*.json')))
        self.assertEqual(len(list(folder.glob('*.done'))),1)

    def test_legacy_staging_is_observable_but_not_claimed_resumable(self):
        r=self.request();folder=self.ops.transfer_dir(self.args);key=hashlib.sha256(r['path'].encode()).hexdigest()
        (folder/(key+'.json')).write_text(json.dumps({k:r[k] for k in ('path','uploadId','totalSize','sha256')}))
        (folder/(key+'.part')).write_bytes(b'ab')
        value=self.status(r);self.assertTrue(value['legacy']);self.assertFalse(value['resumable'])
        changed={k:v for k,v in r.items() if k!='uploadId'};changed['sha256']='e'*64
        self.assertEqual(self.status(changed)['state'],'CONFLICT')
        self.assertEqual((folder/(key+'.part')).read_bytes(),b'ab')

    def test_official_upload_list_and_exact_cancel_without_local_source(self):
        self.upload(b'old published draft')
        r=self.request();self.put(r,b'ab',0)
        listed=self.node.process('files.upload.list',self.args)
        self.assertEqual(listed['uploads'][0]['uploadId'],r['uploadId']);self.assertTrue(listed['uploads'][0]['cancelable'])
        request={**self.args,'uploadId':r['uploadId']}
        result=self.node.process('files.upload.cancel',request);self.assertEqual(result['state'],'CANCELED')
        self.assertEqual(self.node.process('files.upload.cancel',request),result)
        self.assertEqual(self.node.process('files.upload.list',self.args)['uploads'],[])
        self.assertEqual(self.ops.store.dev_paths(*self.ops.identity(self.args))['code'].joinpath('train.py').read_bytes(),b'old published draft')
        with self.assertRaisesRegex(ValueError,'canceled'):self.put(r,b'ab',0)

    def test_upload_cancel_lost_cleanup_receipt_is_recoverable_and_commit_unknown_is_preserved(self):
        r=self.request();self.put(r,b'ab',0)
        folder=self.ops.transfer_dir(self.args);meta=folder/(hashlib.sha256(r['path'].encode()).hexdigest()+'.json')
        original=Path.unlink
        def fail_meta(path,*args,**kwargs):
            if path==meta:raise OSError('synthetic metadata unlink failure')
            return original(path,*args,**kwargs)
        args={**self.args,'uploadId':r['uploadId']}
        with patch.object(Path,'unlink',fail_meta),self.assertRaises(OSError):self.node.process('files.upload.cancel',args)
        self.assertTrue(meta.exists());self.assertEqual(self.node.process('files.upload.cancel',args)['state'],'CANCELED');self.assertFalse(meta.exists())
        newer=self.request();self.put(newer,b'ab',0)
        value=json.loads(meta.read_text());self.node.atomic_json(meta,{**value,'state':'COMMITTING'})
        before=meta.read_bytes()
        with self.assertRaisesRegex(ValueError,'unconfirmed'):self.node.process('files.upload.cancel',{**self.args,'uploadId':newer['uploadId']})
        self.assertEqual(meta.read_bytes(),before)

    def test_pending_upload_cancel_never_follows_other_owner_and_rejects_extra_fields(self):
        r=self.request();self.put(r,b'ab',0)
        other={**self.args,'userId':'demo-user-4'};self.node.process('projects.create',other)
        self.assertEqual(self.node.process('files.upload.list',other)['uploads'],[])
        self.assertEqual(self.node.process('files.upload.cancel',{**other,'uploadId':r['uploadId']})['state'],'ABSENT')
        for extra in ({'hostAdmin':True},{'path':'train.py'},{'area':'output'},{'root':'/data1'}):
            with self.assertRaises(ValueError):self.node.process('files.upload.cancel',{**self.args,'uploadId':r['uploadId'],**extra})
        self.assertEqual(self.status(r)['receivedBytes'],2)


def rpc_fixture():
    """Private test bridge: real native file operations on a temporary project."""
    os.umask(0o077)
    fixture=UploadRecovery('runTest');fixture.setUp()
    paths=fixture.ops.store.dev_paths(*fixture.ops.identity(fixture.args))
    (paths['env']/'bin').mkdir()
    (paths['env']/'bin/python').write_text('synthetic interpreter, never executed')
    (paths['env']/'pyvenv.cfg').write_text('home = /opt/conda/bin\n')
    original=fixture.node.atomic_json;interrupted=False
    def lose_completion(path,value):
        nonlocal interrupted
        if str(path).endswith('.done') and not interrupted:
            interrupted=True;raise OSError('synthetic completion interruption')
        return original(path,value)
    try:
        with patch.object(fixture.node,'atomic_json',side_effect=lose_completion):
            for line in sys.stdin:
                request=json.loads(line);op=request['operation'];args=request.get('args',{})
                try:
                    if op=='fixture.assert-clean':
                        folder=fixture.ops.transfer_dir(fixture.args)
                        code=fixture.ops.store.dev_paths(*fixture.ops.identity(fixture.args))['code']/args['path']
                        result={'unfinished':len(list(folder.glob('*.json'))),'receipts':len(list(folder.glob('*.done'))),
                                'sha256':hashlib.sha256(code.read_bytes()).hexdigest(),'interrupted':interrupted}
                    elif op=='fixture.publish':
                        with patch.object(fixture.node,'run',return_value=''):
                            start=fixture.node.process('projects.publish',{**fixture.args,'key':str(uuid.uuid4())})
                        if fixture.ops.worker(start['operationId'])!=0:raise RuntimeError('Isolated publication failed: '+str(fixture.ops.pending(fixture.args).get('error')))
                        status=fixture.node.process('projects.status',fixture.args)
                        result={'state':status['state'],'publication':status['publication'],'release':status['latestReadyRelease']}
                    else:result=fixture.node.process(op,{**args,**fixture.args})
                    output={'result':result}
                except Exception as error:output={'error':str(error),'status':502 if 'synthetic completion' in str(error) else 400}
                print(json.dumps(output),flush=True)
    finally:
        fixture.tearDown();fixture.doCleanups()


if __name__=='__main__':
    if sys.argv[1:]==['--rpc-fixture']:rpc_fixture()
    else:unittest.main()
