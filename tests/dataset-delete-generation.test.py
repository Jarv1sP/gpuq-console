"""Explicit new registrations after real purge; old background work stays fenced."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid

ROOT=Path(__file__).resolve().parents[1]
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tests'/file)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
F=load('generation_nodes','dataset-delete-node.test.py')
U=load('generation_uploads','dataset-upload.test.py')

class ExplicitRegistration(unittest.TestCase):
    setUp=F.RetirementNodeTests.setUp
    tearDown=F.RetirementNodeTests.tearDown

    def purge(self):
        result=self.node.isolate(F.OWNER,self.key,[])
        confirmed=self.node.commit(F.ADMIN,self.key,result)
        F.D._write_json(self.node._phase_path(self.key,'commit','result'),dict(ok=True,result=confirmed))
        self.source.clock=lambda:result['retainUntil']+1
        self.source.clock_synchronized=lambda:True
        self.source.purge(F.ADMIN,self.key)

    def test_SF7_explicit_approved_registration_creates_new_inode_and_never_revives_old_phase(self):
        self.purge();manifest=F.D._scan(self.cache.sources['approved'])
        for call in (lambda:self.cache.register_manifest(F.ADMIN,'sample',manifest,['owner']),
                     lambda:self.cache.plan(F.OWNER,'sample',self.version)):
            with self.assertRaisesRegex(ValueError,'锁定'):call()
        with self.assertRaisesRegex(PermissionError,'administrator'):
            self.cache.register_source(F.OWNER,'sample','approved',['owner'])
        result=self.cache.register_source(F.ADMIN,'sample','approved',['owner'])
        self.assertEqual(result['version'],self.version)
        self.assertNotEqual(list(self.cache._record_identity('sample',self.version)),self.plan_snapshot()['registration'])
        proof=self.cache.new_registration_proof(F.OWNER,'sample',self.version)
        self.assertEqual(proof['operationId'],self.key)
        self.cache.materialize(F.OWNER,'sample',self.version)
        with self.assertRaisesRegex(ValueError,'restored generation'):
            self.node.isolate(F.OWNER,self.key,[])
        self.assertEqual((self.cache._paths('sample',self.version)['ready']/'data/fixed.txt').read_bytes(),b'fixed full data')
        self.assertEqual(self.source.purge(F.ADMIN,self.key)['state'],'PURGED')
        self.assertEqual(self.cache._retirement_fence('sample',self.version)['state'],'RESTORED')

    def plan_snapshot(self):return self.node._load(self.key)['snapshot']

    def test_SF7_explicit_registration_after_rename_crash_resumes_only_the_fixed_new_inode(self):
        self.purge();move=self.cache._unregister_move_record
        def crash(source,destination):move(source,destination);raise OSError('new registry rename crash')
        with patch.object(self.cache,'_unregister_move_record',side_effect=crash),self.assertRaisesRegex(OSError,'rename crash'):
            self.cache.register_source(F.ADMIN,'sample','approved',['owner'])
        self.assertEqual(self.cache._retirement_fence('sample',self.version)['state'],'PURGED')
        with self.assertRaisesRegex(ValueError,'immutable intent'):
            self.cache.register_source(F.D.Principal('another-admin',True),'sample','approved',['owner'])
        self.cache.register_source(F.ADMIN,'sample','approved',['owner'])
        self.assertEqual(self.cache.new_registration_proof(F.OWNER,'sample',self.version)['state'],'REGISTERED')

    def test_SF7_partial_old_isolation_and_corrupt_purge_never_admit_a_new_generation(self):
        self.node.isolate(F.OWNER,self.key,[])
        with self.assertRaisesRegex(ValueError,'锁定'):
            self.cache.register_source(F.ADMIN,'sample','approved',['owner'])
        self.purge()
        path=self.source._folder(self.key)/'RETIREMENT.json';row=F.N.R.private_read(path)
        F.D._write_json(path,{**row,'rootIdentity':[0,0]})
        with self.assertRaisesRegex(ValueError,'corrupt'):
            self.cache.register_source(F.ADMIN,'sample','approved',['owner'])
        self.assertEqual(self.cache._retirement_fence('sample',self.version)['state'],'PURGED')

    def test_NB2_newly_uploaded_purged_source_is_an_explicit_admin_exit_for_every_purged_peer(self):
        cache=self.empty.cache;cache.sources['approved']=self.cache.sources['approved']
        cache.register_source(F.ADMIN,'sample','approved',['owner']);cache.materialize(F.OWNER,'sample',self.version)
        self.empty.plan(F.ADMIN,'sample',self.version,self.empty_key)
        child=self.empty.isolate(F.ADMIN,self.empty_key,[])
        source=self.node.isolate(F.OWNER,self.key,[child])
        for node,key in ((self.node,self.key),(self.empty,self.empty_key)):
            committed=node.commit(F.ADMIN,key,source)
            F.D._write_json(node._phase_path(key,'commit','result'),dict(ok=True,result=committed))
            node.retirement.clock=lambda:source['retainUntil']+10
            node.retirement.clock_synchronized=lambda:True
            node.retirement.purge(F.ADMIN,key)
        self.cache.register_source(F.ADMIN,'sample','approved',['owner'])
        with self.assertRaisesRegex(ValueError,'not yet complete'):
            self.node.restore(F.ADMIN,self.key)
        self.cache.materialize(F.OWNER,'sample',self.version)
        restored=self.node.restore(F.ADMIN,self.key)
        self.assertEqual(restored['state'],'RESTORED')
        self.assertEqual(self.node.status(F.ADMIN,self.key)['result'],restored)
        self.assertEqual(self.empty.release_absence(F.ADMIN,self.empty_key,restored)['state'],'RELEASED')
        cache.register_source(F.ADMIN,'sample','approved',['owner']);cache.materialize(F.OWNER,'sample',self.version)
        # Both nodes can be deleted as a genuinely new task, not replaying the old IDs.
        for node in (self.node,self.empty):
            fresh=node.plan(F.ADMIN,'sample',self.version,str(uuid.uuid4()))
            self.assertTrue(fresh['complete'])

    def test_NB2_purge_winning_restore_race_can_recover_from_a_new_complete_source(self):
        cache=self.empty.cache;cache.sources['approved']=self.cache.sources['approved']
        cache.register_source(F.ADMIN,'sample','approved',['owner']);cache.materialize(F.OWNER,'sample',self.version)
        self.empty.plan(F.ADMIN,'sample',self.version,self.empty_key)
        child=self.empty.isolate(F.ADMIN,self.empty_key,[])
        source=self.node.isolate(F.OWNER,self.key,[child])
        for node,key in ((self.node,self.key),(self.empty,self.empty_key)):
            committed=node.commit(F.ADMIN,key,source)
            F.D._write_json(node._phase_path(key,'commit','result'),dict(ok=True,result=committed))
            node.retirement.clock=lambda:source['retainUntil']+10
            node.retirement.clock_synchronized=lambda:True
        self.empty.retirement.purge(F.ADMIN,self.empty_key)
        original=self.node._write;collected=False
        def finish_collection_before_restore_intent(row):
            nonlocal collected
            if row['state']=='RESTORING' and not collected:
                collected=True
                self.assertEqual(self.source.purge(F.ADMIN,self.key)['state'],'PURGED')
            original(row)
        # Collection wins after the restore precheck but before its durable
        # intent. The failed restore legitimately records adapter state PURGED.
        with patch.object(self.node,'_write',side_effect=finish_collection_before_restore_intent),\
                self.assertRaisesRegex(ValueError,'retention period'):
            self.node.restore(F.ADMIN,self.key)
        self.assertTrue(collected)
        self.assertEqual(self.node._load(self.key)['state'],'PURGED')
        self.assertEqual(self.node.status(F.ADMIN,self.key)['result']['state'],'PURGED')
        purged=self.source._journal(self.key)
        with patch.object(self.source,'_journal',return_value={**purged,'state':'ISOLATED'}),\
                self.assertRaisesRegex(ValueError,'purge journal'):
            self.node.restore(F.ADMIN,self.key)
        self.assertEqual(self.node._load(self.key)['state'],'PURGED')
        self.cache.register_source(F.ADMIN,'sample','approved',['owner'])
        with self.assertRaisesRegex(ValueError,'not yet complete'):
            self.node.restore(F.ADMIN,self.key)
        self.assertEqual(self.node._load(self.key)['state'],'PURGED')
        self.cache.materialize(F.OWNER,'sample',self.version)
        restored=self.node.restore(F.ADMIN,self.key)
        self.assertEqual(restored['state'],'RESTORED')
        self.assertEqual(self.node.status(F.ADMIN,self.key)['result'],restored)
        self.assertEqual(self.empty.release_absence(F.ADMIN,self.empty_key,restored)['state'],'RELEASED')
        cache.register_source(F.ADMIN,'sample','approved',['owner']);cache.materialize(F.OWNER,'sample',self.version)
        for node in (self.node,self.empty):
            self.assertTrue(node.plan(F.ADMIN,'sample',self.version,str(uuid.uuid4()))['complete'])

class ExplicitUpload(unittest.TestCase):
    setUp=U.PersonalUploads.setUp
    tearDown=U.PersonalUploads.tearDown
    call=U.PersonalUploads.call
    admit=U.PersonalUploads.admit
    seal=U.PersonalUploads.seal
    fill=U.PersonalUploads.fill

    def test_SF7_same_owner_same_name_same_bytes_upload_after_purge_is_new_personal_provenance(self):
        first,_,files=self.seal();self.fill(first['uploadId'],files)
        self.call('commit',uploadId=first['uploadId']);self.assertEqual(self.u.worker(self.user,first['uploadId'],'commit'),0)
        dataset,version=first['dataset'],first['version'];owner=U.D.Principal(self.user)
        old=list(self.cache._record_identity(dataset,version))
        R=F.N.R;retirement=R.DatasetRetirement(self.cache,'upload-fixture')
        key=str(uuid.uuid4());result=retirement.isolate(owner,dataset,version,key,retirement.inspect(owner,dataset,version))
        retirement.clock=lambda:result['retainUntil']+1;retirement.clock_synchronized=lambda:True
        retirement.purge(U.D.Principal('builtin-admin',True),key)
        second,_,files=self.seal();self.assertEqual(second['state'],'UPLOADING')
        self.assertNotEqual(second['uploadId'],first['uploadId'])
        self.fill(second['uploadId'],files);self.call('commit',uploadId=second['uploadId'])
        self.assertEqual(self.u.worker(self.user,second['uploadId'],'commit'),0)
        self.assertEqual(self.call('status',uploadId=second['uploadId'])['state'],'READY')
        self.assertNotEqual(list(self.cache._record_identity(dataset,version)),old)
        proof=self.cache._provenance(dataset,version)
        self.assertEqual(proof['origin'],'upload');self.assertEqual(proof['receipt'],second['uploadId'])
        self.assertTrue(self.cache.deletion_permissions(owner,dataset,version)['memberAllowed'])
        with self.assertRaisesRegex(PermissionError,'owner'):
            self.cache.new_registration_proof(U.D.Principal('demo-user-2'),dataset,version)

if __name__=='__main__':unittest.main()
