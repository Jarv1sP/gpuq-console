"""Same-node copies use real files/hashes; only launch/mount tables are synthetic."""
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch
import uuid

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('copy_storage_fixture',HERE/'personal-storage.test.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)


class Copies(fixture.PersonalStorageTests):
    def setUp(self):
        super().setUp()
        definition=importlib.util.spec_from_file_location('private_copy_tests',HERE.parent/'deploy/personal-storage.py')
        self.module=importlib.util.module_from_spec(definition);definition.loader.exec_module(self.module)
        n=SimpleNamespace(CONFIG=self.config,HERE=HERE.parent/'deploy',ENV={},
                          projects=lambda:SimpleNamespace(store=self.store),workspace=lambda user:None)
        self.copies=self.module.PersonalCopies(n)
        guard=patch.object(self.copies.storage.guard,'uuid_device',return_value=self.root.stat().st_dev)
        guard.start();self.addCleanup(guard.stop)
        self.launches=[]
        def launch(user,key):
            folder,_=self.copies.read(user,key)
            self.copies.s.atomic_json(folder/'status.json',{'state':'QUEUED','phase':'WAITING'})
            self.launches.append(key);return self.copies.status(user,key)
        self.copies.launch=launch;self.copies.stopped=lambda user,key:True
        self.source=self.copies.storage.data_path(self.user,'hdd',create=True)/'source'
        self.source.mkdir(mode=0o700)
        (self.source/'empty-dir').mkdir(mode=0o700)
        self.bytes=(b'abcdefg'*500000)+b'END'
        (self.source/'model.bin').write_bytes(self.bytes)
        self.target=self.copies.storage.data_path(self.user,'ssd',create=True)/'target'
        self.args={'userId':self.user,'key':str(uuid.uuid4()),'sourceTier':'hdd','targetTier':'ssd',
                   'sourcePath':'source','targetPath':'target'}

    @unittest.skipUnless(sys.platform.startswith('linux'),'production atomic no-replace requires Linux')
    def test_copy_verified_while_source_preserved_and_no_duplicate_launch(self):
        first=self.copies.begin(self.args)
        self.assertEqual(first['state'],'QUEUED');self.assertEqual(self.launches,[self.args['key']])
        self.assertEqual(self.copies.begin(self.args)['key'],first['key']);self.assertEqual(len(self.launches),1)
        self.assertEqual(self.copies.worker(self.user,self.args['key']),0)
        result=self.copies.status(self.user,self.args['key'])
        self.assertEqual(result['state'],'SUCCEEDED');self.assertEqual(result['bytes'],len(self.bytes))
        self.assertEqual((self.target/'model.bin').read_bytes(),self.bytes)
        self.assertEqual((self.source/'model.bin').read_bytes(),self.bytes)
        self.assertTrue((self.target/'empty-dir').is_dir())

    def test_existing_target_changed_key_and_cross_owner_never_overwrite(self):
        self.target.mkdir(mode=0o700);(self.target/'keep').write_bytes(b'keep')
        with self.assertRaisesRegex(ValueError,'exists'):self.copies.begin(self.args)
        self.assertEqual((self.target/'keep').read_bytes(),b'keep');self.assertFalse(self.launches)
        self.target.joinpath('keep').unlink();self.target.rmdir()
        self.copies.begin(self.args)
        changed={**self.args,'targetPath':'other'}
        with self.assertRaisesRegex(ValueError,'Same UUID'):self.copies.begin(changed)
        with self.assertRaises((ValueError,FileNotFoundError)):self.copies.status('different-owner',self.args['key'])
        self.assertEqual(len(self.launches),1)

    @unittest.skipUnless(sys.platform.startswith('linux'),'production atomic no-replace requires Linux')
    def test_resume_verifies_existing_partial_prefix_without_recopying_it(self):
        self.copies.begin(self.args)
        payload=self.copies.folder(self.user,self.args['key'],create=True,tier='ssd')/'payload'
        payload.mkdir(mode=0o700);(payload/'model.bin').write_bytes(self.bytes[:1024**2])
        self.assertEqual(self.copies.worker(self.user,self.args['key']),0)
        self.assertEqual((self.target/'model.bin').read_bytes(),self.bytes)

    def test_wrong_partial_prefix_stays_failed_and_original_bytes_preserved(self):
        self.copies.begin(self.args)
        payload=self.copies.folder(self.user,self.args['key'],create=True,tier='ssd')/'payload'
        payload.mkdir(mode=0o700);(payload/'model.bin').write_bytes(b'WRONG')
        self.assertEqual(self.copies.worker(self.user,self.args['key']),1)
        self.assertEqual(self.copies.status(self.user,self.args['key'])['state'],'FAILED')
        self.assertEqual((payload/'model.bin').read_bytes(),b'WRONG');self.assertFalse(self.target.exists())

    def test_canceled_copy_is_permanent_and_does_not_remove_source(self):
        self.copies.begin(self.args);result=self.copies.cancel(self.user,self.args['key'])
        self.assertEqual(result['state'],'CANCELED')
        self.assertEqual(self.copies.worker(self.user,self.args['key']),1)
        with self.assertRaises(ValueError):self.copies.resume(self.user,self.args['key'])
        self.assertTrue(self.source.is_dir());self.assertFalse(self.target.exists())

    @unittest.skipUnless(sys.platform.startswith('linux'),'production atomic no-replace requires Linux')
    def test_lost_final_receipt_reuses_same_committed_directory(self):
        self.copies.begin(self.args);original=self.copies.s.atomic_json;failed=[False]
        def save(path,value):
            if Path(path).name=='status.json' and value.get('state')=='SUCCEEDED' and not failed[0]:
                failed[0]=True;raise OSError('simulated lost receipt')
            return original(path,value)
        with patch.object(self.copies.s,'atomic_json',side_effect=save):
            self.assertEqual(self.copies.worker(self.user,self.args['key']),1)
        inode=self.target.stat().st_ino
        self.assertEqual(self.copies.resume(self.user,self.args['key'])['state'],'QUEUED')
        self.assertEqual(self.copies.worker(self.user,self.args['key']),0)
        self.assertEqual(self.target.stat().st_ino,inode)
        self.assertEqual((self.target/'model.bin').read_bytes(),self.bytes)

    def test_resume_requires_confirmed_stopped_worker_and_source_identity(self):
        self.copies.begin(self.args)
        folder,_=self.copies.read(self.user,self.args['key'])
        self.copies.s.atomic_json(folder/'status.json',{'state':'FAILED','phase':'STOPPED'})
        self.copies.stopped=lambda user,key:False
        with self.assertRaises(ValueError):self.copies.resume(self.user,self.args['key'])
        self.assertEqual(len(self.launches),1)


if __name__=='__main__':unittest.main()
