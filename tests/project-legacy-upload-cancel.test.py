"""Exact old upload recovery; only isolated temporary files and child processes.

Linux exercises the real renameat2 no-replace syscall and flock concurrency.
Mac fixtures substitute rename only for flow coverage, never production proof.
"""
import base64
import hashlib
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import uuid

spec=importlib.util.spec_from_file_location('legacy_upload_security',Path(__file__).with_name('project-security.test.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)


class LegacyUploadCancel(base.ProjectSecurity):
    def setUp(self):
        super().setUp()
        if sys.platform!='linux':
            library=patch.object(self.ops.legacy_upload_partial.__globals__['ctypes'],'CDLL',
                                 return_value=type('FixtureLib',(),{'renameat2':object()})())
            library.start();self.addCleanup(library.stop)
            def flow_move(source_fd,source,target_fd,target):
                try:os.stat(target,dir_fd=target_fd,follow_symlinks=False)
                except FileNotFoundError:pass
                else:raise FileExistsError('Fixture never replaces an existing destination')
                os.rename(source,target,src_dir_fd=source_fd,dst_dir_fd=target_fd)
            move=patch.object(self.ops,'upload_quarantine_move',side_effect=flow_move)
            move.start();self.addCleanup(move.stop)

    def legacy(self,data=b'partial',total=20,path='weights/model.bin',**extra):
        record={'path':path,'uploadId':str(uuid.uuid4()),'totalSize':total,
                'sha256':hashlib.sha256(b'x'*total).hexdigest()}
        folder=self.ops.transfer_dir(self.args);key=hashlib.sha256(path.encode()).hexdigest()
        meta=folder/(key+'.json');self.node.atomic_json(meta,{**record,**extra})
        part=folder/(key+'.part');part.write_bytes(data);part.chmod(0o600)
        return record,folder,meta,part

    def cancel(self,record):
        return self.node.process('files.upload.cancel',{**self.args,'uploadId':record['uploadId']})

    def put(self,record):
        return self.node.process('files.put',{**self.args,**record,'offset':0,'final':False,
            'data':base64.b64encode(b'p').decode()})

    def test_partial_cancel_keeps_all_evidence_and_target_and_old_release(self):
        self.upload(b'old draft')
        root=self.ops.store.dev_paths(*self.ops.identity(self.args))['code']
        (root/'weights').mkdir();(root/'weights/model.bin').write_bytes(b'untouched target')
        environment=self.ops.store.dev_paths(*self.ops.identity(self.args))['env']
        (environment/'bin').mkdir();(environment/'bin/python').write_text('synthetic interpreter, never executed')
        (environment/'pyvenv.cfg').write_text('home = synthetic-base\n')
        published=self.ops.store.publish(*self.ops.identity(self.args))
        r,folder,meta,part=self.legacy();original_meta=meta.read_bytes();original_part=part.read_bytes()
        target=(root/'weights/model.bin').read_bytes();state=self.ops.store.status(*self.ops.identity(self.args))
        self.assertEqual(state['latestReadyRelease'],published['release']);self.assertTrue(state['releases'])
        row=self.node.process('files.upload.list',self.args)['uploads'][0]
        self.assertTrue(row['legacy'] and row['cancelable'])
        receipt=self.cancel(r);self.assertEqual(receipt,{'protocol':1,'state':'CANCELED','uploadId':r['uploadId']})
        q=folder/'.canceled-staging'/r['uploadId']
        self.assertEqual((q/'metadata.json').read_bytes(),original_meta)
        self.assertEqual((q/'partial.part').read_bytes(),original_part)
        self.assertEqual((root/'weights/model.bin').read_bytes(),target)
        self.assertEqual(self.ops.store.status(*self.ops.identity(self.args))['releases'],state['releases'])
        self.assertFalse(meta.exists() or part.exists());self.assertEqual(self.node.process('files.upload.list',self.args)['uploads'],[])
        self.assertEqual(self.cancel(r),receipt)
        self.assertEqual(self.node.process('files.upload.status',{**self.args,**r})['state'],'CANCELED')
        with self.assertRaisesRegex(ValueError,'canceled'):self.put(r)
        self.assertEqual((q/'partial.part').read_bytes(),original_part)

    def test_durable_canceled_fence_precedes_quarantine_and_lost_ack_continues_same_id(self):
        r,folder,meta,part=self.legacy();original=self.node.atomic_json;calls=[]
        def lose_receipt(path,value):
            original(path,value);calls.append(path.name)
            if path.name==r['uploadId']+'.canceled':raise OSError('Lost canceled ACK before quarantine')
        with patch.object(self.node,'atomic_json',side_effect=lose_receipt),self.assertRaisesRegex(OSError,'Lost canceled'):
            self.cancel(r)
        self.assertTrue(meta.exists() and part.exists());self.assertTrue((folder/(r['uploadId']+'.canceled')).exists())
        with self.assertRaisesRegex(ValueError,'canceled'):self.put(r)
        self.assertEqual(self.node.process('files.upload.status',{**self.args,**r})['state'],'CANCELING')
        self.assertEqual(self.cancel(r)['state'],'CANCELED');self.assertFalse(meta.exists() or part.exists())

    def test_interrupted_first_move_keeps_publication_barrier_and_recovers_exact_inode(self):
        r,folder,meta,part=self.legacy();move=self.ops.upload_quarantine_move
        def fail_metadata(source_fd,source,target_fd,target):
            if target=='metadata.json':raise OSError('Synthetic metadata move interrupt')
            return move(source_fd,source,target_fd,target)
        with patch.object(self.ops,'upload_quarantine_move',side_effect=fail_metadata),self.assertRaisesRegex(OSError,'interrupt'):
            self.cancel(r)
        self.assertTrue(meta.exists());self.assertFalse(part.exists())
        q=folder/'.canceled-staging'/r['uploadId'];inode=(q/'partial.part').stat().st_ino
        listed=self.node.process('files.upload.list',self.args)['uploads'][0]
        self.assertEqual(listed['state'],'CANCELING');self.assertTrue(listed['cancelable'])
        with self.assertRaisesRegex(ValueError,'Unfinished project upload'):
            self.node.process('projects.publish',self.args)
        self.assertEqual(self.cancel(r)['state'],'CANCELED');self.assertEqual((q/'partial.part').stat().st_ino,inode)

    def test_full_missing_committing_completed_and_extra_metadata_stay_unknown(self):
        for kind in ('full','missing','committing','complete','extra'):
            with self.subTest(kind=kind):
                r,folder,meta,part=self.legacy(path='weights/'+kind+'.bin',data=b'x'*20 if kind=='full' else b'partial',
                    **({'state':'COMMITTING'} if kind=='committing' else {'unknown':'extra'} if kind=='extra' else {}))
                if kind=='missing':part.unlink()
                if kind=='complete':self.node.atomic_json(meta.with_suffix('.done'),{'identity':r})
                before={p.name:p.read_bytes() for p in folder.iterdir() if p.is_file()}
                row=next(v for v in self.node.process('files.upload.list',self.args)['uploads'] if v['uploadId']==r['uploadId'])
                self.assertFalse(row['cancelable'])
                with self.assertRaisesRegex(ValueError,'unconfirmed'):self.cancel(r)
                self.assertEqual(before,{p.name:p.read_bytes() for p in folder.iterdir() if p.is_file()})

    def test_part_symlink_hardlink_and_changed_bytes_never_quarantine(self):
        r,folder,meta,part=self.legacy();outside=folder/'unrelated';outside.write_bytes(b'private evidence');outside.chmod(0o600)
        part.unlink();part.symlink_to(outside)
        with self.assertRaises(ValueError):self.cancel(r)
        self.assertEqual(outside.read_bytes(),b'private evidence');part.unlink();os.link(outside,part)
        with self.assertRaises(ValueError):self.cancel(r)
        part.unlink();part.write_bytes(b'partial');part.chmod(0o600)
        original=self.node.atomic_json
        def lost(path,value):
            original(path,value)
            if path.name==r['uploadId']+'.canceled':raise OSError('Lost ACK')
        with patch.object(self.node,'atomic_json',side_effect=lost),self.assertRaises(OSError):self.cancel(r)
        part.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'changed'):self.cancel(r)
        self.assertEqual(part.read_bytes(),b'changed');self.assertTrue(meta.exists())
        with self.assertRaisesRegex(ValueError,'canceled'):self.put(r)

    def test_quarantine_collision_and_duplicate_uuid_preserve_every_object(self):
        r,folder,meta,part=self.legacy();q=folder/'.canceled-staging'/r['uploadId'];q.mkdir(parents=True,mode=0o700)
        q.parent.chmod(0o700);q.chmod(0o700);(q/'partial.part').write_bytes(b'other evidence')
        with self.assertRaisesRegex(ValueError,'unconfirmed'):self.cancel(r)
        self.assertEqual((q/'partial.part').read_bytes(),b'other evidence');self.assertEqual(part.read_bytes(),b'partial')
        r2,folder2,meta2,part2=self.legacy(path='other.bin');r3={**r2,'path':'third.bin'}
        key=hashlib.sha256(r3['path'].encode()).hexdigest();self.node.atomic_json(folder2/(key+'.json'),r3)
        p3=folder2/(key+'.part');p3.write_bytes(b'partial');p3.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'unconfirmed'):self.cancel(r2)
        self.assertTrue(meta2.exists() and part2.exists() and p3.exists())

    def test_other_owner_same_uuid_and_forged_cancel_arguments_never_touch_staging(self):
        r,folder,meta,part=self.legacy();other={**self.args,'userId':'demo-user-43'}
        self.node.process('projects.create',other)
        self.assertEqual(self.node.process('files.upload.cancel',{**other,'uploadId':r['uploadId']})['state'],'ABSENT')
        for extra in ({'hostAdmin':True},{'path':r['path']},{'area':'output'},{'root':'/data2'}):
            with self.assertRaises(ValueError):self.node.process('files.upload.cancel',{**self.args,'uploadId':r['uploadId'],**extra})
        self.assertTrue(meta.exists() and part.exists());self.assertFalse((folder/(r['uploadId']+'.canceled')).exists())

    @unittest.skipUnless(sys.platform=='linux','real renameat2 and independent Linux flock required')
    def test_linux_real_no_replace_and_cancel_vs_legacy_chunk_share_store_lock(self):
        r,folder,meta,part=self.legacy();context=multiprocessing.get_context('fork');queue=context.Queue()
        def competing_cancel():
            try:queue.put(('ok',self.cancel(r)))
            except Exception as error:queue.put(('error',str(error)))
        with self.ops.store.locked(*self.ops.identity(self.args)):
            process=context.Process(target=competing_cancel);process.start();process.join(3)
            if process.is_alive():process.terminate();process.join();self.fail('independent cancellation did not respect bounded lock')
            outcome=queue.get(timeout=1);self.assertEqual(outcome[0],'error');self.assertIn('being published or changed',outcome[1])
            self.assertTrue(meta.exists() and part.exists())
        q=folder/'.canceled-staging'/r['uploadId'];q.mkdir(parents=True,mode=0o700)
        q.parent.chmod(0o700);q.chmod(0o700);(q/'collision').write_bytes(b'existing')
        with self.ops.store.locked(*self.ops.identity(self.args)):
            with self.ops.store.lifetime(*self.ops.identity(self.args)):
                src=os.open(folder,os.O_RDONLY|os.O_DIRECTORY);dst=os.open(q,os.O_RDONLY|os.O_DIRECTORY)
                try:
                    with self.assertRaises(FileExistsError):self.ops.upload_quarantine_move(src,part.name,dst,'collision')
                finally:os.close(src);os.close(dst)
        self.assertEqual((q/'collision').read_bytes(),b'existing');self.assertTrue(part.exists())
        self.assertEqual(self.cancel(r)['state'],'CANCELED')
        with self.assertRaisesRegex(ValueError,'canceled'):self.put(r)


if __name__=='__main__':unittest.main()
