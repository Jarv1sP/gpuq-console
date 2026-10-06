"""Fixed-UUID sync cancellation on disposable stores, never a live node."""
import base64
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import patch
import uuid

spec=importlib.util.spec_from_file_location('sync_cancel_fixture',Path(__file__).with_name('snapshot-sync.test.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
USER=base.USER


class SyncCancelTests(unittest.TestCase):
    def setUp(self):
        base.SnapshotSyncTests.setUp(self)
        shutil.copy2(base.DEPLOY/'project-local-import.py',self.nodes[1].HERE/'project-local-import.py')
    tearDown=base.SnapshotSyncTests.tearDown
    call=base.SnapshotSyncTests.call
    seal=base.SnapshotSyncTests.seal

    def pin(self):
        value=self.call('status')
        return {k:value[k] for k in ('snapshotId','source','manifestSha256','revision')}

    def marker(self):
        ops=self.nodes[1].projects()
        return ops.folder/(ops.key(self.begin)+'.sync-canceled-'+self.key+'.json')

    def quiet(self):
        # Exact systemd observation is synthetic; no service is touched.
        result=SimpleNamespace(returncode=1,stdout='LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlGroup=\n')
        return patch('subprocess.run',return_value=result)

    def cancel(self,pin=None):
        with self.quiet():return self.call('cancel',**(pin or self.pin()))

    def test_cancel_preserves_original_receipt_snapshot_code_and_all_old_key_writes(self):
        self.seal();self.call('chunk',path='sub/train.py',offset=0,data=base64.b64encode(self.data).decode())
        n=self.nodes[1];ops=n.projects();receipt=ops.folder/(ops.key(self.begin)+'.sync.json')
        raw=receipt.read_bytes();folder=n.ROOT/'snapshot-sync'/self.pin()['snapshotId']
        before={p.name:p.read_bytes() for p in folder.iterdir() if p.is_file()}
        code=ops.store.dev_paths(USER,'imported')['code']/'sub/train.py';inode=code.stat().st_ino
        canceled=self.cancel();self.assertEqual(canceled['state'],'CANCELED');self.assertTrue(canceled['preservesBytes'])
        self.assertEqual(receipt.read_bytes(),raw);self.assertEqual(before,{p.name:p.read_bytes() for p in folder.iterdir() if p.is_file()})
        self.assertEqual(code.read_bytes(),self.data);self.assertEqual(code.stat().st_ino,inode)
        for action,args in [('manifest',{'offset':0,'data':''}),('seal',{}),('chunk',{'path':'sub/train.py','offset':0,'data':''}),('finish',{})]:
            with self.subTest(action=action),self.assertRaisesRegex(ValueError,'permanently canceled'):self.call(action,**args)
        with self.assertRaisesRegex(ValueError,'permanently canceled'):n.process('projects.sync.begin',self.begin)
        with self.assertRaisesRegex(ValueError,'canceled'):self.call('status',path='sub/train.py')
        self.assertEqual(self.call('status'),canceled);ops.writable({'userId':USER,'project':'imported'})

    @unittest.skipUnless(sys.platform.startswith('linux'),'actual no-replace retirement requires Linux')
    def test_canceled_sync_allows_guarded_retirement_not_slug_recreation(self):
        self.seal();self.cancel();ops=self.nodes[1].projects();args={'userId':USER,'project':'imported'}
        with self.quiet():plan=ops.lifecycle().plan(args)
        self.assertEqual(plan['state'],'ELIGIBLE',plan)
        original=ops.store._project(USER,'imported')[0];(original/'dev/code/keep.txt').write_text('retained')
        with self.quiet():
            plan=ops.lifecycle().plan(args)
            result=ops.lifecycle().retire({**args,'key':str(uuid.uuid4()),'manifestSha256':plan['manifestSha256'],'revision':plan['lifecycle']['revision']})
        self.assertEqual(result['state'],'RETIRED');self.assertTrue(result['preservesBytes']);self.assertTrue(self.marker().exists())
        self.assertEqual(self.call('status')['state'],'CANCELED')
        with self.assertRaises(ValueError):self.nodes[1].process('projects.sync.begin',self.begin)

    def test_receiving_manifest_can_cancel_without_creating_or_replacing_bytes(self):
        self.nodes[1].process('projects.sync.begin',self.begin);self.call('manifest',offset=0,data=base64.b64encode(self.raw[:7]).decode())
        self.assertEqual(self.cancel()['state'],'CANCELED')
        folder=self.nodes[1].ROOT/'snapshot-sync'/self.pin()['snapshotId']
        self.assertEqual((folder/'manifest.part').read_bytes(),self.raw[:7])

    def test_begin_rejects_incomplete_provenance_before_any_receipt_or_snapshot(self):
        ops=self.nodes[1].projects();receipt=ops.folder/(ops.key(self.begin)+'.sync.json')
        root=self.nodes[1].ROOT/'snapshot-sync'
        for source in ({'kind':'git'},{'kind':'git','commit':'HEAD'},
                       {'kind':'git','commit':'a'*40,'machine':'unexpected'},
                       {'kind':'release','machine':'source','project':'code','release':'latest'},
                       {'kind':'release','machine':'source','release':'a'*64}):
            with self.subTest(source=source),self.assertRaisesRegex(ValueError,'provenance'):
                self.nodes[1].process('projects.sync.begin',{**self.begin,'source':source})
            self.assertFalse(receipt.exists());self.assertEqual(list(root.iterdir()),[])
            self.assertEqual(ops.store.list(USER),[])

    def test_cancel_compare_and_swap_binds_every_original_identity(self):
        self.seal();pin=self.pin()
        for field,value in [('snapshotId',str(uuid.uuid4())),('manifestSha256','b'*64),('revision','c'*64),('source',{'kind':'git','commit':'b'*40})]:
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'changed'):self.cancel({**pin,field:value})
            self.assertFalse(self.marker().exists())
        for extra in [{'userId':'another-owner'},{'key':str(uuid.uuid4())},{'project':'another-project'},{'hostAdmin':True}]:
            with self.assertRaises((ValueError,OSError)):self.call('cancel',**pin,**extra)
        self.assertFalse(self.marker().exists())

    def test_confirmed_cancel_removes_only_sync_blocker_from_retirement_plan(self):
        self.seal();ops=self.nodes[1].projects();args={'userId':USER,'project':'imported'}
        with self.quiet():before=ops.lifecycle().plan(args)
        self.assertEqual(before['state'],'BLOCKED');self.assertIn('writer',[r['kind'] for r in before['blockers']])
        self.cancel()
        with self.quiet():after=ops.lifecycle().plan(args)
        self.assertEqual(after['state'],'ELIGIBLE',after);self.assertEqual(after['blockers'],[])

    def test_stale_revision_rejects_cancel_after_manifest_write(self):
        self.nodes[1].process('projects.sync.begin',self.begin);pin=self.pin()
        self.call('manifest',offset=0,data=base64.b64encode(self.raw[:7]).decode())
        with self.assertRaisesRegex(ValueError,'changed'):self.cancel(pin)
        self.assertFalse(self.marker().exists())

    def test_lost_ack_observes_same_uuid_without_any_second_mutation(self):
        self.seal();pin=self.pin();ops=self.nodes[1].projects();s=__import__('sys').modules[type(ops.store).__module__];atomic=s.atomic_json
        def lost(path,value):atomic(path,value);raise OSError('lost acknowledgement')
        with self.quiet(),patch.object(s,'atomic_json',side_effect=lost) as writes:
            with self.assertRaisesRegex(OSError,'lost acknowledgement'):self.call('cancel',**pin)
            self.assertEqual(writes.call_count,1)
        with patch.object(s,'atomic_json',side_effect=AssertionError('status or repeat rewrote proof')):
            self.assertEqual(self.call('status')['state'],'CANCELED');self.assertEqual(self.cancel(pin)['state'],'CANCELED')

    def test_no_proof_raw_canceled_state_does_not_unlock(self):
        self.seal();ops=self.nodes[1].projects();path=ops.folder/(ops.key(self.begin)+'.sync.json');value=json.loads(path.read_text());value['state']='CANCELED';self.nodes[1].atomic_json(path,value)
        with self.assertRaisesRegex(ValueError,'incomplete'):ops.writable(self.begin)
        with self.assertRaisesRegex(ValueError,'receipt identity'):self.call('status')

    def test_complete_receipt_without_cancel_marker_still_requires_own_full_identity(self):
        self.seal();ops=self.nodes[1].projects();path=ops.folder/(ops.key(self.begin)+'.sync.json');original=json.loads(path.read_text())
        for patch_value in ({'state':'CODE_READY','userId':'other-owner'},{'state':'CODE_READY','project':'other-project'},{'state':'CODE_READY','session':'../outside'},{'state':'CODE_READY','key':'invalid'},{'state':'CODE_READY','manifestSha256':'latest'},{'state':'CODE_READY','source':{'kind':'git','commit':'HEAD'}}):
            with self.subTest(patch_value=patch_value):
                self.nodes[1].atomic_json(path,{**original,**patch_value})
                with self.assertRaisesRegex(ValueError,'receipt'):ops.writable(self.begin)
                with self.assertRaisesRegex(ValueError,'receipt'):ops.status(self.begin)
        self.nodes[1].atomic_json(path,{'state':'CODE_READY'})
        with self.assertRaisesRegex(ValueError,'incomplete'):ops.writable(self.begin)

    def test_marker_symlink_hardlink_foreign_identity_and_receipt_change_fail_closed(self):
        self.seal();self.cancel();marker=self.marker();proof=marker.read_bytes();ops=self.nodes[1].projects()
        for mutation in ('symlink','hardlink','foreign','changed-receipt'):
            with self.subTest(mutation=mutation):
                marker.unlink();marker.write_bytes(proof);marker.chmod(0o600)
                backup=marker.with_suffix('.backup');backup.write_bytes(proof);backup.chmod(0o600)
                receipt=ops.folder/(ops.key(self.begin)+'.sync.json');original=receipt.read_bytes()
                if mutation=='symlink':marker.unlink();marker.symlink_to(backup)
                elif mutation=='hardlink':marker.unlink();os.link(backup,marker)
                elif mutation=='foreign':value=json.loads(proof);value['userId']='someone-else';self.nodes[1].atomic_json(marker,value)
                else:value=json.loads(original);value['manifestOffset']+=1;self.nodes[1].atomic_json(receipt,value)
                with self.assertRaises((ValueError,OSError)):ops.writable(self.begin)
                with self.assertRaises((ValueError,OSError)):self.call('status')
                marker.unlink();backup.unlink();receipt.write_bytes(original);receipt.chmod(0o600)
                marker.write_bytes(proof);marker.chmod(0o600)

    def test_snapshot_directory_replacement_invalidates_proof(self):
        self.seal();self.cancel();folder=self.nodes[1].ROOT/'snapshot-sync'/self.pin()['snapshotId']
        folder.rename(folder.with_name(folder.name+'-retained'));folder.mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError,'proof changed'):self.call('status')

    def test_history_upload_unknown_publication_or_terminal_blocks_without_stopping(self):
        self.seal();ops=self.nodes[1].projects();s=__import__('sys').modules[type(ops.store).__module__]
        for kind in ('job','output','upload','publication','terminal'):
            with self.subTest(kind=kind):
                if kind=='job':folder=s.private_dir(self.nodes[1].ROOT/'jobs',create=True);path=folder/(str(uuid.uuid4())+'.json');s.atomic_json(path,{'userId':USER,'project':'imported','state':'SUCCEEDED'})
                elif kind=='output':path=ops.store._project(USER,'imported')[0]/'runs/old-result';path.write_text('preserve')
                elif kind=='upload':folder=s.private_dir(ops.folder/(ops.key(self.begin)+'.uploads'),create=True);path=folder/(str(uuid.uuid4())+'.json');s.atomic_json(path,{'state':'UPLOADING'})
                elif kind=='publication':path=ops.receipt_path(self.begin);s.atomic_json(path,{'state':'UNKNOWN'})
                else:folder=s.private_dir(self.nodes[1].ROOT/'terminals',create=True);path=folder/(str(uuid.uuid4())+'.json');s.atomic_json(path,{'userId':USER,'project':'imported'})
                with patch.object(ops,'terminal_stopped',return_value=False),self.assertRaisesRegex(ValueError,'writer/history'):self.cancel()
                self.assertFalse(self.marker().exists());path.unlink()

    def test_unknown_unit_pid_or_populated_cgroup_blocks_cancel(self):
        self.seal()
        for stdout,code in [('not-properties',1),('LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nControlGroup=\n',0),('LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlGroup=/wrong/unit\n',0)]:
            with patch('subprocess.run',return_value=SimpleNamespace(returncode=code,stdout=stdout)),self.assertRaisesRegex(ValueError,'writer/history'):self.call('cancel',**self.pin())
            self.assertFalse(self.marker().exists())

    def test_complete_sync_cannot_cancel(self):
        self.seal();self.call('chunk',path='sub/train.py',offset=0,data=base64.b64encode(self.data).decode());self.call('finish')
        with self.assertRaisesRegex(ValueError,'unfinished'):self.cancel()
        self.assertFalse(self.marker().exists())

    def test_same_project_writer_lock_prevents_cancel_and_old_key_cannot_resume_after_commit(self):
        self.seal();ops=self.nodes[1].projects();pin=self.pin();entered=threading.Event();release=threading.Event()
        def writer():
            with ops.guard(self.begin):entered.set();release.wait(3)
        with ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(writer);self.assertTrue(entered.wait(2))
            try:
                with self.assertRaises((BlockingIOError,ValueError)):self.cancel(pin)
                self.assertFalse(self.marker().exists())
            finally:release.set();future.result(timeout=3)
        self.assertEqual(self.cancel(pin)['state'],'CANCELED')
        with self.assertRaisesRegex(ValueError,'permanently canceled'):self.call('chunk',path='sub/train.py',offset=0,data='')


if __name__=='__main__':unittest.main()
