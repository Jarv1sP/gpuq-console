"""Trusted bounded archive admission; temporary local stores, no real services."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid

HERE = Path(__file__).resolve().parent
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value

F = module('archive_admission_upload_fixture', HERE/'dataset-upload.test.py')
T = module('archive_admission_transfers', F.DEPLOY/'transfer-jobs.py')
A = module('archive_admission_storage', F.DEPLOY/'storage-archive.py')


class ArchiveAdmission(unittest.TestCase):
    def setUp(self):
        self.f = F.PersonalUploads(); self.f.setUp()
        self.n, self.u, self.user = self.f.node, self.f.u, self.f.user
        self.n.ROOT = self.f.base/'state'; self.n.ROOT.mkdir(mode=0o700)
        self.policy = {'enabled': True, 'machine': 'cold-node', 'authority': 'hdd'}
        self.n.CONFIG.update(machine='cold-node', storageArchive=dict(self.policy), storageAuthority={'enabled': True})
        self.n.atomic_json = F.D._write_json
        self.store = A.A.AuthorityStore(self.f.cache, 'cold-node', self.n.ROOT/'authority', principal=F.D.Principal('builtin-admin', True))
        self.n.storage_authority = lambda: self.store
        self.archive = A.StorageArchive.from_executor(self.n)
        self.n.storage_archive = lambda: self.archive
        self.jobs = T.TransferJobs(self.n); self.n.transfers = lambda: self.jobs

    def tearDown(self): self.f.tearDown()

    def args(self, key=None):
        return {'name': 'incoming', 'key': key or str(uuid.uuid4()), 'manifestBytes': 100,
                'manifestSha256': 'a'*64, 'totalBytes': 10, 'entries': 1}

    def durable(self, args, **changes):
        key = args['key']
        payload = {'userId': self.user, 'sourceMachine': 'hot-node',
            'source': {'id': key, 'token': 'x'*43, 'state': 'READY', **{k: args[k] for k in ('manifestBytes', 'manifestSha256', 'totalBytes', 'entries')}},
            'name': args['name'], 'reference': {'kind': 'datasets', 'dataset': 'original', 'version': 'b'*64}, 'timeoutSec': 60,
            'archiveLane': {'schema': 1, 'targetMachine': 'cold-node', 'authority': 'hdd'}}
        payload.update(changes)
        spec = {**payload, 'id': key, 'attempt': 1, 'createdAt': 1, 'digest': T.digest(payload)}
        self.n.atomic_json(self.jobs.path(key), spec)
        return spec

    def admit_archive(self, args=None):
        args = args or self.args(); self.durable(args)
        return self.u.begin(self.user, args, _archive_transfer=args['key'])

    def test_four_unfinished_personal_uploads_do_not_block_archive(self):
        previous = []
        for _ in range(4):
            key=self.u.begin(self.user, self.args())['uploadId'];previous.append(key)
            session=self.u.load(self.user,key);session.update(state='FAILED',resumeState='RECEIVING_MANIFEST',error='retained prior upload');self.u.save(session)
        before = [self.u.load(self.user, key) for key in previous]
        with self.assertRaisesRegex(ValueError, 'unfinished personal'): self.u.begin(self.user, self.args())
        result = self.admit_archive()
        self.assertEqual(result['state'], 'RECEIVING_MANIFEST')
        self.assertNotIn('archiveAdmission', result)
        self.assertEqual([self.u.load(self.user, key) for key in previous], before)
        self.assertEqual(self.u.load(self.user, result['uploadId'])['archiveAdmission']['targetMachine'], 'cold-node')

    def test_archive_lane_is_bounded_and_does_not_consume_personal_active_limit(self):
        for _ in range(4): self.admit_archive()
        with self.assertRaisesRegex(ValueError, 'unfinished managed archive'): self.admit_archive()
        for _ in range(4): self.u.begin(self.user, self.args())
        with self.assertRaisesRegex(ValueError, 'unfinished personal'): self.u.begin(self.user, self.args())

    def test_all_shared_owner_budgets_and_free_space_still_apply(self):
        for budget in ('maxUserUploads', 'maxUserSessions', 'maxUserBytes', 'maxUserEntries'):
            with self.subTest(budget=budget):
                saved = dict(self.u.limits)
                self.u.limits[budget] = 1
                if budget in ('maxUserUploads', 'maxUserSessions'):
                    if not list(self.u.root.glob('*/?*')): self.u.begin(self.user, self.args())
                with self.assertRaises(ValueError): self.admit_archive()
                self.u.limits = saved
        with patch.object(self.f.cache, '_free', side_effect=ValueError('space unavailable')):
            with self.assertRaisesRegex(ValueError, 'space unavailable'): self.admit_archive()
        self.u.limits['maxUploadBytes']=1
        with self.assertRaisesRegex(ValueError,'configured limit exceeded'):self.admit_archive()

    def test_public_fields_cannot_select_archive_lane(self):
        for key in ('archiveLane', 'archiveAdmission', '_archive_transfer', 'managedArchive'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.f.call('begin', **self.args(), **{key: 1})

    def test_private_lane_requires_matching_durable_owner_name_and_manifest(self):
        for field, value in (('userId', 'demo-user-2'), ('name', 'other'), ('id', str(uuid.uuid4())),
                             ('digest', '0'*64)):
            with self.subTest(field=field):
                args = self.args(); spec = self.durable(args); spec[field] = value
                self.n.atomic_json(self.jobs.path(args['key']), spec)
                with self.assertRaisesRegex(ValueError, 'durable copy'):
                    self.u.begin(self.user, args, _archive_transfer=args['key'])
        for field, value in (('manifestBytes', 101), ('manifestSha256', 'c'*64), ('totalBytes', 11), ('entries', 2)):
            with self.subTest(field=field):
                args = self.args(); self.durable(args); args[field] = value
                with self.assertRaisesRegex(ValueError, 'durable copy'):
                    self.u.begin(self.user, args, _archive_transfer=args['key'])
        with self.assertRaises(FileNotFoundError):
            args = self.args(); self.u.begin(self.user, args, _archive_transfer=args['key'])

    def test_fixed_policy_authority_and_actual_protected_store_rechecked(self):
        cases = [('storageArchive', {'enabled': False}), ('storageArchive', {**self.policy, 'authority': 'other'}),
                 ('storageArchive', {**self.policy, 'machine': 'other'}), ('storageAuthority', {'enabled': False}), ('machine', 'other')]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                args = self.args(); self.durable(args); old = self.n.CONFIG[key]; self.n.CONFIG[key] = value
                try:
                    with self.assertRaisesRegex(ValueError, 'fixed protected'): self.u.begin(self.user, args, _archive_transfer=args['key'])
                finally: self.n.CONFIG[key] = old
        old = self.store.machine; self.store.machine = 'other'
        try:
            with self.assertRaisesRegex(ValueError, 'binding changed'): self.admit_archive()
        finally: self.store.machine = old

    def test_prior_uploads_cannot_be_relabelled_and_token_renewal_preserves_lane(self):
        args = self.args(); self.u.begin(self.user, args); before = self.u.load(self.user, args['key'])
        self.durable(args)
        with self.assertRaisesRegex(ValueError, 'admission lane'): self.u.begin(self.user, args, _archive_transfer=args['key'])
        self.assertEqual(self.u.load(self.user, args['key']), before)
        args = self.args(); self.admit_archive(args); before = self.u.load(self.user, args['key'])
        with self.assertRaisesRegex(ValueError, 'admission lane'): self.u.begin(self.user, args)
        spec = self.jobs.load(args['key']); spec['source']['token'] = 'y'*43
        spec['digest'] = T.digest({k: spec[k] for k in ('userId', 'sourceMachine', 'source', 'name', 'reference', 'timeoutSec', 'archiveLane')})
        self.n.atomic_json(self.jobs.path(args['key']), spec)
        self.u.begin(self.user, args, _archive_transfer=args['key'])
        self.assertEqual(self.u.load(self.user, args['key'])['archiveAdmission'], before['archiveAdmission'])

    def test_corrupt_persisted_lane_fails_closed(self):
        result = self.admit_archive(); session = self.u.load(self.user, result['uploadId'])
        for change in ({'schema': True}, {'transferId': str(uuid.uuid4())}, {'authority': '../x'}, {'sourceMachine': 'cold-node'}, {'extra': 1}):
            with self.subTest(change=change):
                bad = copy.deepcopy(session); bad['archiveAdmission'].update(change); self.u.save(bad)
                with self.assertRaisesRegex(ValueError, 'Corrupt managed archive'): self.u.load(self.user, result['uploadId'])
        self.u.save(session)
    def test_corrupt_durable_reference_or_ticket_creates_no_upload_session(self):
        for field,change in (('reference',{'kind':'projects'}),('reference',{'dataset':'../escape'}),
                             ('reference',{'version':'x'}),('source',{'state':'UPLOADING'}),('source',{'token':None})):
            with self.subTest(field=field,change=change):
                args=self.args();spec=self.durable(args);spec[field].update(change)
                spec['digest']=T.digest({k:spec[k] for k in ('userId','sourceMachine','source','name','reference','timeoutSec','archiveLane')})
                self.n.atomic_json(self.jobs.path(args['key']),spec)
                with self.assertRaises(ValueError):self.u.begin(self.user,args,_archive_transfer=args['key'])
                with self.assertRaises(FileNotFoundError):self.u.load(self.user,args['key'])

if __name__ == '__main__': unittest.main()
