"""Real sealed originals, full dependent copies and permanent retirement proofs.

The fixture replaces only the HTTP transport with an in-process call to the
real AuthorityStore. Its guards, grants, permissions, fixed seals, disk moves,
hashes and target receipts are the production implementations.
"""
import copy
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parents[1]/'deploy'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, DEPLOY/filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


A = load('retirement_authority_tests', 'storage-authority.py')
R = load('retirement_authority_isolation', 'dataset-retirement.py')
D, T = A.D, A.T
ADMIN = D.Principal('administrator', True)
OWNER = D.Principal('owner')
OTHER = D.Principal('another')


class RetirementAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.input = self.base/'approved'
        self.input.mkdir()
        (self.input/'fixed.txt').write_bytes(b'original complete bytes')
        (self.input/'empty').mkdir()
        self.cache = D.DatasetCache(self.base/'original', sources={'approved':self.input}, reserve_bytes=0, lock_timeout=.03)
        with self.cache._locked():
            created = self.cache._register(D.Principal('owner', True), 'source-data', D._scan(self.input), ['owner'],
                                           'approved', _origin='upload', _receipt=str(uuid.uuid4()))
        self.version = created['version']
        self.cache.materialize(OWNER, 'source-data', self.version)
        self.store = A.AuthorityStore(self.cache, 'source-machine', self.base/'authority', principal=ADMIN)
        self.key = str(uuid.uuid4())
        self.targets = []
        store = self.store

        class InProcessTransport:
            def __init__(inner, peer, grant):
                inner.grant = grant

            def call(inner, action, **fields):
                grant = inner.grant
                return store.read(dict(id=grant['id'], action=action, dataset=grant['dataset'], version=grant['version'],
                                       targetMachine=grant['targetMachine'], **fields), grant['token'])

            def close(inner):
                pass

        self.transport = patch.object(A, 'AuthorityClient', InProcessTransport)
        self.transport.start()
        self.addCleanup(self.transport.stop)
        self.add_target('dependent-one')
        self.add_target('dependent-two')
        self.retirement = R.DatasetRetirement(self.cache, 'source-machine', authority=self.store)
        self.snapshot = self.retirement.inspect(OWNER, 'source-data', self.version)

    def tearDown(self):
        for root, _, files in os.walk(self.base):
            os.chmod(root, 0o700)
            for name in files:
                path = Path(root)/name
                if not path.is_symlink():
                    path.chmod(0o600)

    def add_target(self, machine):
        grant = self.store.seal(ADMIN, 'source-data', self.version, str(uuid.uuid4()), machine)
        target = D.DatasetCache(self.base/machine, sources={}, reserve_bytes=0, lock_timeout=.03)
        with target._locked():
            target._register(D.Principal('owner', True), 'replica-data', D._scan(self.input), ['owner'], None,
                             _origin='replica', _receipt=grant['id'])
        target.materialize(ADMIN, 'replica-data', self.version, _source=self.input)
        remote = A.RemoteAuthority('source-machine', dict(address='127.0.0.1', port=1, certificateSha256='a'*64),
                                   self.base/(machine+'-grants'), target_machine=machine)
        remote.install_grant(grant)
        tier = T.DatasetTier(target, authorities={'configured-original':remote})
        tier.verify_authority(ADMIN, 'replica-data', self.version, 'configured-original', 'source-data')
        retirement = R.DatasetRetirement(target, machine, recovery_references=tier.retirement_references)
        snapshot = retirement.inspect(OWNER, 'replica-data', self.version)
        row = dict(cache=target, remote=remote, grant=grant, tier=tier, retirement=retirement, snapshot=snapshot)
        self.targets.append(row)
        return row

    def fence(self, actor=OWNER):
        return self.retirement.fence(actor, 'source-data', self.version, self.key, self.snapshot)

    def target_receipts(self):
        return [t['retirement'].isolate(OWNER, 'replica-data', self.version, self.key, t['snapshot']) for t in self.targets]

    def isolate(self, receipts=None, actor=OWNER):
        if receipts is None:
            self.fence(actor)
            receipts = self.target_receipts()
        return self.retirement.isolate(actor, 'source-data', self.version, self.key, self.snapshot,
                                      _revoke=lambda row:self.store.revoke_for_retirement(actor, row, receipts))

    def original(self):
        return self.cache._paths('source-data', self.version)['ready']/'data'/'fixed.txt'

    def revoked(self, grant):
        return self.store.root/grant['id']/'revoked.json'

    def request(self, grant, action='guard'):
        return dict(id=grant['id'], action=action, dataset=grant['dataset'], version=grant['version'],
                    targetMachine=grant['targetMachine'])

    def test_projection_is_complete_fixed_and_token_free(self):
        dependencies = self.snapshot['authority']
        self.assertEqual(len(dependencies['grants']), 2)
        self.assertEqual(set(g['targetMachine'] for g in dependencies['grants']), {'dependent-one','dependent-two'})
        self.assertNotIn('token', str(dependencies))
        self.assertEqual(dependencies['pins'], sorted('authority-'+t['grant']['id'] for t in self.targets))
        for target in self.targets:
            ref = target['snapshot']['authorityReferences'][0]
            self.assertEqual(ref['grantId'], target['grant']['id'])
            self.assertEqual(ref['sourceDataset'], 'source-data')
            self.assertEqual(ref['targetMachine'], target['retirement'].machine)

    def test_complete_all_target_isolation_then_original_seven_day_retention(self):
        self.fence()
        receipts = self.target_receipts()
        result = self.isolate(receipts)
        self.assertTrue(result['isolated'])
        self.assertTrue(result['complete'])
        self.assertFalse(self.original().exists())
        self.assertEqual((self.retirement._folder(self.key)/'payload/ready/data/fixed.txt').read_bytes(), b'original complete bytes')
        row = self.retirement._journal(self.key)
        self.assertEqual(len(row['revocations']), 2)
        self.assertGreaterEqual(result['retainUntil'], row['createdAt']+7*86400)
        for target in self.targets:
            grant = target['grant']
            self.assertTrue(self.revoked(grant).exists())
            with self.assertRaises(PermissionError):
                self.store.read(self.request(grant), grant['token'])
            self.assertEqual((target['retirement']._folder(self.key)/'payload/ready/data/fixed.txt').read_bytes(), b'original complete bytes')

    def test_missing_target_preserves_original_pins_and_every_grant(self):
        self.fence()
        receipts = self.target_receipts()
        with self.assertRaisesRegex(ValueError, 'Every authority dependent'):
            self.isolate(receipts[:1])
        self.assertTrue(self.original().exists())
        self.assertEqual(set(self.cache._tier('source-data', self.version)['pins']), set(self.snapshot['authority']['pins']))
        self.assertTrue(all(not self.revoked(t['grant']).exists() for t in self.targets))

    def test_external_consumption_lock_blocks_data_revocation_without_changing_its_fence(self):
        self.fence();receipts=self.target_receipts()
        with self.store.reference_lock('source-data',self.version):
            with self.assertRaisesRegex(ValueError,'busy'):self.isolate(receipts)
        self.assertTrue(self.original().exists())
        self.assertFalse(any(self.revoked(t['grant']).exists() for t in self.targets))
        self.assertTrue(self.isolate(receipts)['isolated'])

    def test_file_absence_or_archive_intent_retired_never_proves_data_isolation(self):
        self.fence()
        for receipt in ([], [dict(state='RETIRED', sourceRetired=True, neverDispatched=True)]):
            with self.subTest(receipt=receipt), self.assertRaises(ValueError):
                self.isolate(receipt)
        self.assertTrue(self.original().exists())

    def test_wrong_generation_machine_reference_receipt_and_short_retention_stop(self):
        self.fence()
        valid = self.target_receipts()
        changes = [lambda t:t.update(state='READY'), lambda t:t.update(isolated=False),
                   lambda t:t.update(fenceState='FENCED'), lambda t:t.update(machine='wrong-target'),
                   lambda t:t.update(version='0'*64), lambda t:t.update(proofSha256='invalid'),
                   lambda t:t.update(retainUntil=0), lambda t:t.update(complete='yes'),
                   lambda t:t['authorityReferences'][0].update(receiptSha256='0'*64),
                   lambda t:t['authorityReferences'][0].update(sourceDataset='wrong-source'),
                   lambda t:t['authorityReferences'][0].update(targetMachine='wrong-target'),
                   lambda t:t['authorityReferences'][0].update(grantId=str(uuid.uuid4()))]
        for change in changes:
            receipts = copy.deepcopy(valid)
            change(receipts[0])
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.isolate(receipts)
            self.assertTrue(self.original().exists())
            self.assertTrue(all(not self.revoked(t['grant']).exists() for t in self.targets))

    def test_duplicate_mapping_and_external_revoke_fields_are_refused(self):
        self.fence()
        valid = self.target_receipts()
        for receipts in (valid+[valid[0]], [{**valid[0], 'force':True}, valid[1]],
                         [{**valid[0], 'authorityReferences':valid[0]['authorityReferences']*2}, valid[1]]):
            with self.subTest(receipts=receipts), self.assertRaises(ValueError):
                self.isolate(receipts)
        self.assertTrue(self.original().exists())

    def test_new_grant_before_fence_invalidates_fixed_dependency_plan(self):
        self.add_target('late-dependent')
        with self.assertRaisesRegex(ValueError, 'stale'):
            self.fence()
        self.assertTrue(self.original().exists())
        self.assertIsNone(self.cache._retirement_fence('source-data', self.version))

    def test_fenced_original_blocks_new_grant_and_old_stream_without_removing_pins(self):
        self.fence()
        with self.assertRaisesRegex(ValueError, '锁定'):
            self.store.seal(ADMIN, 'source-data', self.version, str(uuid.uuid4()), 'late-dependent')
        for target in self.targets:
            with self.assertRaises(ValueError):
                self.store.read(self.request(target['grant']), target['grant']['token'])
        self.assertTrue(self.original().exists())
        self.assertEqual(len(self.cache._tier('source-data', self.version)['pins']), 2)

    def test_unknown_pin_incomplete_private_grant_and_changed_seal_stop_inventory(self):
        with self.cache._locked():
            tier = self.cache._tier('source-data', self.version)
            tier['pins']['authority-unknown'] = dict(owner=ADMIN.user_id, createdAt=1)
            self.cache._write_tier('source-data', self.version, tier)
        with self.assertRaisesRegex(ValueError, 'unknown authority pins'):
            self.retirement.inspect(OWNER, 'source-data', self.version)
        with self.cache._locked():
            del tier['pins']['authority-unknown']
            self.cache._write_tier('source-data', self.version, tier)
        seal = self.store.root/self.targets[0]['grant']['id']/'sealed.json'
        previous = seal.read_bytes()
        D._write_json(seal, dict(changed=True))
        with self.assertRaises(ValueError):
            self.retirement.inspect(OWNER, 'source-data', self.version)
        seal.write_bytes(previous)
        seal.chmod(0o600)
        incomplete = self.store.root/str(uuid.uuid4())
        D._mkdir(incomplete)
        with self.assertRaises(FileNotFoundError):
            self.retirement.inspect(OWNER, 'source-data', self.version)

    def test_non_owner_or_changed_source_identity_cannot_authorize_deletion(self):
        with self.assertRaises(PermissionError):
            self.retirement.inspect(OTHER, 'source-data', self.version)
        registration = self.cache._paths('source-data')['.registry']/(self.version+'.json')
        before = D._read_json(registration)
        D._write_json(registration, before)
        with self.assertRaises((ValueError, PermissionError)):
            self.retirement.inspect(OWNER, 'source-data', self.version)
        self.assertTrue(self.original().exists())

    def test_partial_revocation_fsync_failure_is_resumable_only_same_transaction(self):
        self.fence()
        receipts = self.target_receipts()
        write = A.D._write_json
        count = [0]

        def interrupted(path, value):
            if Path(path).name == 'revoked.json':
                count[0] += 1
                if count[0] == 2:
                    raise OSError('crash before second revocation fsync')
            return write(path, value)

        with patch.object(A.D, '_write_json', side_effect=interrupted), self.assertRaises(OSError):
            self.isolate(receipts)
        self.assertTrue(self.original().exists())
        self.assertEqual(sum(self.revoked(t['grant']).exists() for t in self.targets), 1)
        result = self.isolate(receipts)
        self.assertTrue(result['isolated'])
        self.assertEqual(len(self.retirement._journal(self.key)['revocations']), 2)

    def test_changed_confirmations_cannot_resume_a_partial_revocation(self):
        self.fence()
        receipts = self.target_receipts()
        write = A.D._write_json
        count = [0]

        def interrupted(path, value):
            if Path(path).name == 'revoked.json':
                count[0] += 1
                if count[0] == 2:
                    raise OSError('interrupt')
            return write(path, value)

        with patch.object(A.D, '_write_json', side_effect=interrupted), self.assertRaises(OSError):
            self.isolate(receipts)
        with self.assertRaisesRegex(ValueError, 'another immutable operation'):
            self.isolate(list(reversed(receipts)))
        self.assertTrue(self.original().exists())
        self.assertEqual(sum(self.revoked(t['grant']).exists() for t in self.targets), 1)

    def test_private_revocation_requires_exact_scope_and_source_fence(self):
        self.fence()
        self.target_receipts()
        fake = dict(snapshot=self.snapshot, dataset='source-data', version=self.version,
                    operationId=self.key, actor=OWNER.user_id, admin=False)
        with self.assertRaisesRegex(ValueError, '锁定'):
            self.store.revoke_for_retirement(OWNER, fake, [])
        self.assertTrue(self.original().exists())

    def test_no_authority_adapter_or_wrong_revocation_proof_never_moves_original(self):
        self.fence()
        receipts = self.target_receipts()
        with self.assertRaisesRegex(ValueError, 'confirmed'):
            self.retirement.isolate(OWNER, 'source-data', self.version, self.key, self.snapshot)
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            self.retirement.isolate(OWNER, 'source-data', self.version, self.key, self.snapshot, _revoke=lambda row:[])
        self.assertTrue(self.original().exists())
        self.assertTrue(all(not self.revoked(t['grant']).exists() for t in self.targets))
        self.retirement.authority = None
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            self.retirement.isolate(OWNER, 'source-data', self.version, self.key, self.snapshot, _revoke=lambda row:[])
        self.assertTrue(self.original().exists())

    def test_restore_new_registration_keeps_old_tokens_dead_and_allows_new_seal(self):
        self.isolate()
        result = self.retirement.restore(ADMIN, self.key)
        self.assertEqual(result['state'], 'RESTORED')
        self.assertEqual(self.original().read_bytes(), b'original complete bytes')
        self.assertNotEqual(list(self.cache._record_identity('source-data', self.version)), self.snapshot['registration'])
        self.assertEqual(self.cache._tier('source-data', self.version)['pins'], {})
        for target in self.targets:
            grant = target['grant']
            with self.assertRaises(PermissionError):
                self.store.read(self.request(grant), grant['token'])
            with self.assertRaises(PermissionError):
                self.store.seal(ADMIN, 'source-data', self.version, grant['id'], grant['targetMachine'])
        fresh = self.store.seal(ADMIN, 'source-data', self.version, str(uuid.uuid4()), 'dependent-one')
        self.assertEqual(self.store.read(self.request(fresh), fresh['token']), fresh['receipt'])
        dependencies = self.retirement.inspect(OWNER, 'source-data', self.version)['authority']
        self.assertEqual([g['id'] for g in dependencies['grants']], [fresh['id']])

    def test_corrupt_or_missing_permanent_revocation_blocks_restore_and_expiry_cleanup(self):
        isolated = self.isolate()
        path = self.revoked(self.targets[0]['grant'])
        saved = path.read_bytes()
        for action in ('corrupt','missing'):
            if action == 'corrupt':
                D._write_json(path, dict(state='REVOKED'))
            else:
                path.unlink()
            with self.subTest(action=action), self.assertRaises((ValueError, FileNotFoundError)):
                self.retirement.restore(ADMIN, self.key)
            self.retirement.clock = lambda:isolated['retainUntil']+1
            with self.subTest(action=action), self.assertRaises((ValueError, FileNotFoundError)):
                self.retirement.purge(ADMIN, self.key)
            self.assertTrue((self.retirement._folder(self.key)/'payload/ready/data/fixed.txt').exists())
            path.write_bytes(saved)
            path.chmod(0o600)

    def test_target_config_unknown_authority_or_changed_installed_binding_is_not_guessable(self):
        target = self.targets[0]
        no_projection = R.DatasetRetirement(target['cache'], 'dependent-one')
        with self.assertRaisesRegex(ValueError, 'fixed configured'):
            no_projection.inspect(OWNER, 'replica-data', self.version)
        target['remote'].peer['certificateSha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'binding changed'):
            target['retirement'].inspect(OWNER, 'replica-data', self.version)


    def test_ordinary_removed_dependency_with_live_cached_grant_is_not_an_empty_node(self):
        target=self.targets[0]
        references=target['snapshot']['authorityReferences']
        node_helpers=load('deleted_dependency_projection','dataset-retirement-node.py')
        node=node_helpers.RetirementNode(target['retirement'],self.base/'dependent-plan',tier=target['tier'],principal=ADMIN)
        target['cache'].unregister(ADMIN,'replica-data',self.version)
        with self.assertRaisesRegex(ValueError,'fixed authority|orphaned'):
            node.grant_locations(self.version,references)
        self.assertTrue(self.original().exists())
        self.assertTrue(self.cache._tier('source-data',self.version)['pins'])

    def test_certified_removed_alias_closes_with_real_remote_authority_after_source_revocation(self):
        helpers=load('completed_removed_alias_real_authority','dataset-retirement-node.py')
        source=helpers.RetirementNode(self.retirement,self.base/'source-node-plan',
            tier=T.DatasetTier(self.cache),principal=ADMIN)
        source_plan=source.plan(OWNER,'source-data',self.version,self.key)
        authorization={k:source_plan[k] for k in ('operationId','machine','dataset','version','owners','memberAllowed','complete','snapshotSha256')}
        nodes=[]
        for target in self.targets:
            nodes.append(helpers.RetirementNode(target['retirement'],self.base/(target['retirement'].machine+'-plan'),
                tier=target['tier'],principal=ADMIN))
        removed=self.targets[0];cache=removed['cache'];remote=removed['remote']
        proof=copy.deepcopy(cache._tier('replica-data',self.version)['recovery']['proof'])
        normal=cache.unregister(ADMIN,'replica-data',self.version)
        self.assertTrue(normal['unregistered'])
        # Model the already confirmed legacy ordinary removal, which has no
        # provenance record. All removal/inode/tier/grant evidence is real.
        (cache.root/'.provenance'/'replica-data'/(self.version+'.json')).unlink()
        references=removed['snapshot']['authorityReferences']
        self.assertEqual(nodes[0].grant_locations(self.version,references),
            [dict(dataset='replica-data',version=self.version,authorityReference=references[0])])
        alias_key=str(uuid.uuid4());live_key=str(uuid.uuid4())
        nodes[0].plan(OWNER,'replica-data',self.version,alias_key,authorization=authorization,references=references)
        nodes[1].plan(OWNER,'replica-data',self.version,live_key)
        source.fence(OWNER,self.key)
        receipts=[nodes[0].isolate(OWNER,alias_key,[]),nodes[1].isolate(OWNER,live_key,[])]
        self.assertFalse(receipts[0]['complete']);self.assertTrue(receipts[1]['complete'])
        isolated=source.isolate(OWNER,self.key,receipts)
        self.assertTrue(isolated['complete']);self.assertTrue(isolated['isolated'])
        for target in self.targets:
            self.assertTrue(self.revoked(target['grant']).exists())
            self.assertFalse(target['remote'].fence_path('source-data',self.version).exists())
            with self.assertRaises(PermissionError):self.store.read(self.request(target['grant']),target['grant']['token'])
        self.assertEqual(nodes[0].commit(OWNER,alias_key,isolated),receipts[0])
        for _ in range(2):
            self.assertEqual(nodes[0].status(OWNER,alias_key)['result'],receipts[0])
            self.assertEqual(nodes[0].worker_status(OWNER,alias_key)['result'],receipts[0])
        self.assertEqual(remote.retirement_reference(ADMIN,proof),references[0])
        with self.assertRaises(PermissionError):
            with remote.guard(ADMIN,proof):self.fail('Revoked source must not serve this old grant')
        restored=source.restore(ADMIN,self.key)
        self.assertEqual(nodes[0].release_absence(ADMIN,alias_key,restored)['state'],'RESTORED')
        cache.register_manifest(ADMIN,'replica-data',self.cache._record(OWNER,'source-data',self.version)['manifest'],['owner'])
        self.assertIsNone(cache._tier('replica-data',self.version)['recovery'])
        self.assertEqual(nodes[0].status(OWNER,alias_key)['result']['state'],'RESTORED')
        with self.assertRaises(PermissionError):self.store.read(self.request(removed['grant']),removed['grant']['token'])
        self.assertTrue((cache.root/'.trash'/normal['recoveryId']/'REMOVAL.json').exists())

    def test_all_distinct_physical_aliases_of_one_grant_need_real_isolation(self):
        target=self.targets[0];cache,tier=target['cache'],target['tier']
        with cache._locked():
            cache._register(D.Principal('owner',True),'other-alias',D._scan(self.input),['owner'],None,
                _origin='replica',_receipt=target['grant']['id'])
        cache.materialize(ADMIN,'other-alias',self.version,_source=self.input)
        tier.verify_authority(ADMIN,'other-alias',self.version,'configured-original','source-data')
        snapshot=target['retirement'].inspect(OWNER,'other-alias',self.version)
        target['snapshot']=target['retirement'].inspect(OWNER,'replica-data',self.version)
        self.fence();receipts=self.target_receipts()
        with self.assertRaisesRegex(ValueError,'physical authority alias'):
            self.isolate(receipts)
        self.assertFalse(self.revoked(target['grant']).exists())
        self.assertTrue((cache._paths('other-alias',self.version)['ready']/'data/fixed.txt').exists())
        alias=target['retirement'].isolate(OWNER,'other-alias',self.version,str(uuid.uuid4()),snapshot)
        self.assertTrue(self.isolate([*receipts,alias])['isolated'])
        self.assertTrue(self.revoked(target['grant']).exists())
        self.assertEqual((target['retirement']._folder(alias['operationId'])/'payload/ready/data/fixed.txt').read_bytes(),b'original complete bytes')

if __name__ == '__main__':
    unittest.main()
