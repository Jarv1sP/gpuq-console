"""HDD-only ingress: disposable bytes, real upload code and pinned LAN copy."""
import base64
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid

HERE = Path(__file__).resolve().parent
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE/file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

F = load('hdd_only_upload_fixture', 'dataset-upload.test.py')
D = load('hdd_only_direct_fixture', 'direct-upload.test.py')
T = load('hdd_only_transfer_fixture', 'transfers.test.py')


class HddIngress(unittest.TestCase):
    setUp = F.PersonalUploads.setUp
    tearDown = F.PersonalUploads.tearDown
    call = F.PersonalUploads.call
    admit = F.PersonalUploads.admit
    seal = F.PersonalUploads.seal
    fill = F.PersonalUploads.fill

    def cache_only(self):
        self.node.CONFIG['storageTier'] = {'enabled': True, 'budgetBytes': 1024**3}

    def test_new_member_and_admin_uploads_denied_without_admission(self):
        _, args, _, _ = self.admit()
        self.cache_only()
        for user in (self.user, 'builtin-admin'):
            for key in (args['key'], str(uuid.uuid4())):
                with self.subTest(user=user, key=key), self.assertRaisesRegex(PermissionError, 'HDD warehouse'):
                    self.call('begin', user=user, **{**args, 'key': key})
                if key != args['key'] or user != self.user:
                    self.assertFalse(self.u.folder(user, key).exists())

    def test_legacy_manifest_blocked_but_status_revoke_and_discard_retained(self):
        result, _, raw, _ = self.admit()
        key = result['uploadId']; self.cache_only()
        before = self.u.folder(self.user, key)/'manifest.part'
        for transport in ('vps-relay', 'campus-direct', 'tail-upload', 'lan-peer'):
            with self.subTest(transport=transport), self.assertRaises(PermissionError):
                self.u.manifest_bytes(self.user, {'uploadId':key}, 0, raw, transport=transport)
        self.assertFalse(before.exists())
        self.assertEqual(self.call('status', uploadId=key)['state'], 'RECEIVING_MANIFEST')
        self.assertTrue(self.call('direct-revoke', uploadId=key)['revoked'])
        self.call('discard', uploadId=key)
        self.assertEqual(self.u.worker(self.user,key,'discard'), 0)
        self.assertEqual(self.call('status', uploadId=key)['state'], 'DISCARDED')

    def test_legacy_chunk_and_control_writes_blocked_without_deleting_partial(self):
        result, _, files = self.seal(); key = result['uploadId']
        self.call('chunk', uploadId=key, path='train.txt', offset=0, data=base64.b64encode(b'hello').decode())
        stage = self.cache._paths(result['dataset'], result['version'])['.staging']/'data'/'train.txt'
        before = stage.read_bytes(); self.cache_only()
        for action, args in (('chunk',{'path':'train.txt','offset':5,'data':'LQ=='}),
                             ('seal',{}),('commit',{}),('direct-ticket',{})):
            with self.subTest(action=action), self.assertRaises(PermissionError):
                self.call(action, uploadId=key, **args)
        for transport in ('vps-relay','campus-direct','tail-upload','lan-peer'):
            with self.subTest(transport=transport), self.assertRaises(PermissionError):
                self.u.chunk_bytes(self.user, {'uploadId':key,'path':'train.txt'},5,b'-',transport=transport)
        self.assertEqual(stage.read_bytes(),before)
        self.assertEqual(self.call('status',uploadId=key,path='train.txt')['file']['offset'],5)

    def test_previously_scheduled_seal_worker_cannot_register_or_stage(self):
        result, _, raw, _ = self.admit(); key=result['uploadId']
        self.call('manifest',uploadId=key,offset=0,data=base64.b64encode(raw).decode())
        self.call('seal',uploadId=key); self.cache_only()
        self.assertEqual(self.u.worker(self.user,key,'seal'),1)
        self.assertEqual(self.call('status',uploadId=key)['state'],'FAILED')
        self.assertEqual(self.cache.list_datasets(F.D.Principal(self.user)),{'datasets':[]})

    def test_previously_scheduled_commit_worker_cannot_publish(self):
        result, _, files=self.seal();key=result['uploadId'];self.fill(key,files)
        self.call('commit',uploadId=key);self.cache_only()
        paths=self.cache._paths(result['dataset'],result['version'])
        before=(paths['.staging']/'data'/'train.txt').read_bytes()
        self.assertEqual(self.u.worker(self.user,key,'commit'),1)
        self.assertFalse(paths['ready'].exists())
        self.assertEqual((paths['.staging']/'data'/'train.txt').read_bytes(),before)

    def test_public_request_cannot_supply_private_preparation_scope(self):
        result, args, _, _=self.admit();self.cache_only()
        for field in ('_peer_cache_preparation','cachePreparation','_archive_transfer','storageTier'):
            with self.subTest(field=field),self.assertRaises(ValueError):
                self.call('begin',**args,**{field:True})

    def test_hdd_upload_lifecycle_remains_unchanged(self):
        self.node.CONFIG['storageTier']={'enabled':False}
        result,_,files=self.seal();key=result['uploadId'];self.fill(key,files)
        self.call('commit',uploadId=key)
        self.assertEqual(self.u.worker(self.user,key,'commit'),0)
        self.assertEqual(self.call('status',uploadId=key)['state'],'READY')


class OldDirectTicket(unittest.TestCase):
    setUp=D.DirectTests.setUp
    tearDown=D.DirectTests.tearDown
    call=D.DirectTests.call
    admit=D.DirectTests.admit
    seal=D.DirectTests.seal
    fill=D.DirectTests.fill
    raw=D.DirectTests.raw
    ticket=D.DirectTests.ticket

    def test_real_legacy_manifest_ticket_cannot_write_after_role_is_cache(self):
        result,_,raw,_=self.admit();key=result['uploadId'];grant=self.ticket(key)
        self.node.CONFIG['storageTier']={'enabled':True}
        with self.assertRaises(PermissionError):self.raw(grant,key,'manifest',offset=0,data=raw)
        with self.assertRaises(PermissionError):self.ticket(key)
        self.assertEqual(self.raw(grant,key,'status')['state'],'RECEIVING_MANIFEST')
        self.assertFalse((self.u.folder(self.user,key)/'manifest.part').exists())

    def test_real_legacy_chunk_ticket_cannot_write_after_role_is_cache(self):
        result,_,_=self.seal();key=result['uploadId'];grant=self.ticket(key)
        self.node.CONFIG['storageTier']={'enabled':True}
        with self.assertRaises(PermissionError):self.raw(grant,key,'chunk',path='train.txt',offset=0,data=b'hello')
        self.assertEqual(self.raw(grant,key,'status',path='train.txt')['file']['offset'],0)


class WarehouseCopy(unittest.TestCase):
    setUp=T.Transfers.setUp
    tearDown=T.Transfers.tearDown
    control=T.Transfers.control

    def cache_only(self, source='gpu-1'):
        self.target.CONFIG['storageTier']={'enabled':True,'budgetBytes':1024**3}
        self.target.CONFIG['storageArchive']={'enabled':True,'machine':source,'authority':'hdd'}
        self.target.transfers=lambda:self.dst
        # This fixture intentionally has no storage GC adapter; byte admission
        # itself remains real. Cache-budget/GC has its own independent tests.
        guard=patch.object(self.target,'dataset_cache_admission',return_value={'evicted':[]})
        guard.start();self.patches.append(guard)

    def test_real_pinned_hdd_ready_copy_prepares_ssd_without_public_ingress(self):
        self.cache_only();self.dst.start(self.args)
        self.assertEqual(self.dst.worker(self.key,1),0,self.dst.load(self.key,'.result.json'))
        result=self.dst.status(self.control())
        self.assertEqual(result['state'],'SUCCEEDED');self.assertEqual(result['version'],self.version)
        uploads=self.target.dataset_uploads()
        with self.assertRaises(PermissionError):uploads.process('datasets.upload.commit',{'userId':T.USER,'uploadId':self.key})

    def test_copy_from_other_source_is_refused_and_retains_source_lease(self):
        self.cache_only(source='different-warehouse');self.dst.start(self.args)
        self.assertEqual(self.dst.worker(self.key,1),1)
        self.assertEqual(self.dst.status(self.control())['state'],'PAUSED')
        self.assertFalse(self.target.dataset_uploads().folder(T.USER,self.key).exists())
        self.assertEqual(self.src.load(self.key,'.source-lease.json')['state'],'HELD')

    def test_scope_cannot_change_owner_or_outlive_cancellation(self):
        self.cache_only();self.dst.start(self.args);spec=self.dst.load(self.key)
        uploads=self.target.dataset_uploads()
        with uploads._peer_cache_preparation(spec):
            with self.assertRaises(PermissionError):uploads.require_ingress('demo-user-999',self.key)
            self.target.atomic_json(self.dst.path(self.key,'.cancel'),{'userId':T.USER})
            with self.assertRaises(PermissionError):uploads.require_ingress(T.USER,self.key)
        with self.assertRaises(PermissionError):uploads.require_ingress(T.USER,self.key)

    def test_canceled_cache_transfer_can_still_query_and_discard(self):
        self.cache_only();self.dst.start(self.args);spec=self.dst.load(self.key)
        info=spec['source']
        self.dst.upload(spec,'begin',name=spec['name'],key=self.key,
                        **{k:info[k] for k in ('manifestBytes','manifestSha256','totalBytes','entries')})
        self.target.atomic_json(self.dst.path(self.key,'.cancel'),{'userId':T.USER})
        self.assertEqual(self.dst.upload(spec,'status',uploadId=self.key)['state'],'RECEIVING_MANIFEST')
        self.assertEqual(self.dst.upload(spec,'discard',uploadId=self.key)['state'],'DISCARDING')
        self.assertEqual(self.target.dataset_uploads().worker(T.USER,self.key,'discard'),0)
        self.assertEqual(self.dst.upload(spec,'status',uploadId=self.key)['state'],'DISCARDED')


if __name__=='__main__':unittest.main()
