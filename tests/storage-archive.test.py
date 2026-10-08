"""Disposable archive journal tests, including actual pinned-TLS certification.

No systemd, GPU, production configuration, or remote node is used. Only the
worker launcher/process-state probes are substituted; seal/cache/recovery are
the real production modules and the TLS test uses a real local HTTPS server.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid
from dataset_retention_helpers import protected_original

SPEC = importlib.util.spec_from_file_location('archive_tests', Path(__file__).resolve().parents[1]/'deploy/storage-archive.py')
M = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(M)
A, D = M.A, M.D
ADMIN = D.Principal('builtin-admin', True)
USER = 'demo-user-1'
POLICY = dict(enabled=True, machine='cold-node', authority='hdd')


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name).resolve()
        input_path = self.root/'input'; input_path.mkdir()
        (input_path/'file').write_bytes(b'archive fixture\x00'*2048)
        self.cold = D.DatasetCache(self.root/'cold', sources={'input': input_path}, reserve_bytes=0)
        self.hot = D.DatasetCache(self.root/'hot', sources={}, reserve_bytes=0)
        self.version = self.cold.register_source(ADMIN, 'original', 'input', [USER])['version']
        self.cold.materialize(ADMIN, 'original', self.version)
        self.manifest = self.cold.export_manifest(ADMIN, 'original', self.version)['manifest']
        self.hot.register_manifest(ADMIN, 'replica', self.manifest, [USER])
        self.hot.materialize(ADMIN, 'replica', self.version, _source=input_path)
        self.peer = dict(address='127.0.0.1', port=18443, certificateSha256='0'*64)
        self.store = A.AuthorityStore(self.cold, 'cold-node', self.root/'authority', principal=ADMIN)
        self.node = self.executor('cold-node', self.cold, self.root/'source-state')
        self.node.CONFIG.update(storageAuthority={'enabled': True}, transferPeers={'hot-node': dict(self.peer)})
        self.node.storage_authority = lambda: self.store
        self.source = M.StorageArchive.from_executor(self.node)
        self.source.spawn = Mock()
        self.source.worker_state = Mock(return_value='STOPPED')
        self.request = dict(opId=str(uuid.uuid4()), userId=USER,
                            source={'dataset':'original', 'version':self.version}, targetMachine='hot-node')
        self.server = None

    def executor(self, machine, cache, state):
        return SimpleNamespace(CONFIG={'machine':machine, 'storageArchive':dict(POLICY)}, ROOT=state,
            HERE=Path(__file__).resolve().parents[1]/'deploy', ENV={}, dataset_cache=lambda:(D, cache), run=Mock())

    def tearDown(self):
        if self.server:
            self.server.shutdown(); self.server.server_close(); self.thread.join(2)
        for folder, _, files in os.walk(self.root):
            os.chmod(folder, 0o700)
            for name in files:
                path = Path(folder)/name
                if not path.is_symlink(): os.chmod(path, 0o600)
        self.tmp.cleanup()

    def provision(self):
        value = self.source.provision(self.request)
        self.assertEqual(value['state'], 'PROVISIONING')
        self.assertEqual(self.source.worker(self.request['opId']), 0)
        return self.source.provision(self.request)['grant']

    def tls_target(self):
        cert, key = self.root/'cert.pem', self.root/'key.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),
            '-out',str(cert),'-subj','/CN=archive-fixture','-days','1'], check=True, capture_output=True)
        store = self.store; self.read_requests = []
        requests = self.read_requests
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(inner):
                try:
                    if inner.path != '/authority': raise ValueError('endpoint')
                    request = json.loads(inner.rfile.read(int(inner.headers['Content-Length'])))
                    requests.append(request)
                    data = dict(ok=True, result=store.read(request, inner.headers['Authorization'][7:]))
                    status = 200
                except Exception:
                    data = dict(ok=False, error='fixed authority refused'); status = 403
                raw = json.dumps(data).encode(); inner.send_response(status)
                inner.send_header('Content-Length', str(len(raw))); inner.end_headers(); inner.wfile.write(raw)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(cert, key)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.peer = dict(address='127.0.0.1', port=self.server.server_port,
                        certificateSha256=hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest())
        remote = A.RemoteAuthority('cold-node', self.peer, self.root/'grants', target_machine='hot-node')
        tier = A.T.DatasetTier(self.hot, authorities={'hdd': remote})
        node = self.executor('hot-node', self.hot, self.root/'target-state')
        node.CONFIG.update(storageAuthorities={'hdd':{'machine':'cold-node'}}, transferPeers={'cold-node':dict(self.peer)})
        node.storage_node = lambda: SimpleNamespace(tier=tier)
        self.target = M.StorageArchive.from_executor(node)
        self.target_node = node
        return self.target

    def intent(self, *, dataset='original', op=None, origin='upload'):
        return dict(opId=op or str(uuid.uuid4()), userId=USER,
                    reference=dict(dataset=dataset, version=self.version), origin=origin)

    def test_default_off_has_no_cache_or_directory_side_effects(self):
        node = SimpleNamespace(CONFIG={}, dataset_cache=Mock(side_effect=AssertionError('cache touched')))
        disabled = M.StorageArchive.from_executor(node)
        self.assertEqual(disabled.outbox_list({'limit':8}), {'events':[]})
        with self.assertRaisesRegex(ValueError, 'disabled'): disabled.provision(self.request)
        node.dataset_cache.assert_not_called()

    def removed_intent(self):
        intent = self.intent()
        self.source.outbox_begin(intent)
        self.source.outbox_ready(dict(opId=intent['opId'], userId=USER))
        # Intent retirement consumes a genuine ordinary-removal receipt. This
        # positive fixture needs another sealed complete original; it cannot
        # use the intent's RETIRED state as last-copy protection.
        protected_original(self.cold, D, self.root/'removed-intent-original')
        receipt = self.cold.unregister(ADMIN, 'original', self.version)
        h = A._sha([USER, 'cold-node', 'original', self.version, 'cold-node'])
        grant = h[:8]+'-'+h[8:12]+'-5'+h[13:16]+'-a'+h[17:20]+'-'+h[20:32]
        return dict(id=intent['opId'], userId=USER, dataset='original', version=self.version,
                    recoveryId=receipt['recoveryId'], grantId=grant, certifyId=str(uuid.uuid4()))

    def test_retire_normal_removed_registration_is_durable_exact_and_idempotent(self):
        request = self.removed_intent()
        event = self.source._load(self.source._event_path(request['id']))
        record = self.cold.root/'.trash'/request['recoveryId']/'registration'/(self.version+'.json')
        self.assertEqual(list(D._stamp(record.stat()))[:4], event['registration'][:4])
        value = self.source.retire(request)
        self.assertEqual(value['state'], 'RETIRED'); self.assertTrue(value['neverDispatched'])
        self.assertEqual(self.source.retire(dict(reversed(list(request.items())))), value)
        self.assertEqual(self.source.outbox_list({'limit':8}), {'events':[]})
        self.assertEqual(self.source.outbox_ready({'opId':request['id'],'userId':USER})['state'], 'RETIRED')
        self.source.spawn.assert_not_called()
        with self.assertRaisesRegex(ValueError, 'cannot be restarted'):
            self.source.outbox_begin(self.intent(op=request['id']))
        with self.assertRaisesRegex(ValueError, 'cannot be changed'):
            self.source.retire({**request, 'recoveryId':'unregister-'+'0'*32})
        # New registration gets a distinct publish event, not the retired event.
        self.cold.register_manifest(ADMIN, 'original', self.manifest, [USER])
        new = self.intent(); self.assertEqual(self.source.outbox_begin(new), {'id':new['opId']})
        self.assertEqual(self.source.retire(request), value)

    def test_queued_retire_is_source_only_and_keeps_other_native_lane(self):
        target = self.tls_target(); intent = self.intent(dataset='replica')
        target.outbox_begin(intent); target.outbox_ready(dict(opId=intent['opId'], userId=USER))
        protected_original(self.hot, D, self.root/'queued-intent-original')
        removed = self.hot.unregister(ADMIN, 'replica', self.version)
        request = dict(id=intent['opId'], userId=USER, dataset='replica', version=self.version,
                       recoveryId=removed['recoveryId'], mode='queued-ingest-v1')
        lane = target.root/'control'/'lane'/'state.json'; other = {'opId':str(uuid.uuid4())};target._save(lane,other)
        value = target.retire(request)
        self.assertEqual(value['state'],'RETIRED');self.assertTrue(value['sourceRetired']);self.assertNotIn('neverDispatched',value)
        self.assertEqual(target._load(lane),other);self.assertEqual(target.retire(request),value)
        self.assertEqual(target.outbox_list({'limit':8}),{'events':[]})
        with self.assertRaises(ValueError):target.retire({**request,'grantId':str(uuid.uuid4())})
        with self.assertRaises(ValueError):target.retire({**request,'mode':'another-mode'})
        # Recreated same hash cannot be certified by a new queued retirement.
        self.hot.register_manifest(ADMIN,'replica',self.manifest,[USER])
        new = self.intent(dataset='replica');target.outbox_begin(new)
        with self.assertRaises(ValueError):target.retire({**request,'id':new['opId']})

    def test_intent_retirement_does_not_authorize_erasing_the_last_complete_copy(self):
        intent = self.intent()
        self.source.outbox_begin(intent)
        self.source.outbox_ready(dict(opId=intent['opId'], userId=USER))
        with self.assertRaisesRegex(ValueError, '最后一份'):
            self.cold.unregister(ADMIN, 'original', self.version)
        self.assertEqual(self.source.outbox_list({'limit':8})['events'][0]['state'], 'READY')
        self.assertEqual((self.cold._paths('original', self.version)['ready']/'data/file').read_bytes(),
                         b'archive fixture\x00'*2048)
        self.assertEqual(list((self.cold.root/'.trash').iterdir()), [])

    def test_retire_rejects_recreated_registration_missing_or_uncommitted_proof(self):
        request = self.removed_intent()
        folder = self.cold.root/'.trash'/request['recoveryId']
        receipt = D._read_json(folder/'REMOVAL.json')
        for changes in ({'unregistered':False}, {'owners':['demo-user-2']}, {'versions':[]}, {'dataset':'other'}):
            D._write_json(folder/'REMOVAL.json', {**receipt, **changes})
            with self.assertRaisesRegex(ValueError, 'does not prove'): self.source.retire(request)
        D._write_json(folder/'REMOVAL.json', receipt)
        with self.assertRaises(FileNotFoundError): self.source.retire({**request,'recoveryId':'unregister-'+'0'*32})
        record = folder/'registration'/(self.version+'.json'); saved = record.read_bytes()
        record.rename(record.with_suffix('.kept')); record.write_bytes(saved)
        with self.assertRaisesRegex(ValueError, 'publish identity'): self.source.retire(request)
        record.unlink(); record.with_suffix('.kept').rename(record)
        self.cold.register_manifest(ADMIN, 'original', self.manifest, [USER])
        with self.assertRaisesRegex(ValueError, 'recreated'): self.source.retire(request)

    def test_retire_rejects_workers_journals_pins_unknown_and_wrong_identity(self):
        request = self.removed_intent()
        for state in ('RUNNING','UNKNOWN'):
            self.source.worker_state.return_value = state
            with self.assertRaisesRegex(ValueError, 'unconfirmed'): self.source.retire(request)
        self.source.worker_state.return_value = 'STOPPED'
        path = self.source._op_path(request['grantId']); path.parent.mkdir()
        with self.assertRaisesRegex(ValueError, 'Existing'): self.source.retire(request)
        path.parent.rmdir()
        with self.assertRaisesRegex(ValueError, 'same-HDD'): self.source.retire({**request,'grantId':str(uuid.uuid4())})
        with self.assertRaises(ValueError): self.source.retire({**request,'userId':'demo-user-2'})
        lane = self.source.root/'control'/'lane'/'state.json'; self.source._save(lane,{'opId':request['certifyId']})
        with self.assertRaisesRegex(ValueError, 'native archive lane'): self.source.retire(request)
        lane.unlink()
        # A valid persistent pin remains a hard veto even after an anomalous removal.
        self.cold.register_manifest(ADMIN, 'original', self.manifest, [USER])
        self.cold.materialize(ADMIN, 'original', self.version, _source=self.root/'input')
        self.cold.pin(ADMIN, 'original', self.version, 'test-pin')
        (self.cold.root/'.registry'/'original'/(self.version+'.json')).unlink()
        with self.assertRaises(ValueError): self.source.retire(request)

    def test_config_and_private_requests_reject_user_paths_roles_or_peer_override(self):
        for config in ({'enabled':1}, {**POLICY,'root':'/tmp'}, {'enabled':True,'machine':'cold-node'},
                       {**POLICY,'authority':'../hdd'}):
            with self.assertRaises(ValueError): M.policy(config)
        for extra in ('hostAdmin','root','endpoint','certificateSha256','authority'):
            with self.assertRaises(ValueError): self.source.provision({**self.request,extra:True})
        with self.assertRaises(ValueError): self.source.provision({**self.request,'targetMachine':'unknown'})
        with self.assertRaises(ValueError): self.source.provision({**self.request,'userId':'arbitrary-account'})
        self.source.spawn.assert_not_called()

    def test_source_requires_exact_single_owner_and_protected_ready(self):
        self.cold.set_owners(ADMIN, 'original', [USER, 'demo-user-2'])
        with self.assertRaises(PermissionError): self.source.provision(self.request)
        self.cold.set_owners(ADMIN, 'original', [USER])
        with self.cold._locked():
            tier = self.cold._tier('original', self.version); tier['role']='cache'
            self.cold._write_tier('original', self.version, tier)
        with self.assertRaisesRegex(ValueError,'protected original'): self.source.provision(self.request)
        self.source.spawn.assert_not_called()

    def test_provision_is_async_intent_precedes_launch_and_poll_never_rehashes(self):
        def check_launch(op):
            row = A._load(self.source._op_path(op))
            self.assertEqual(row['state'], 'PROVISIONING')
            self.assertEqual(A._load(self.source.root/'control'/'lane'/'state.json'), {'opId':op})
        self.source.spawn.side_effect = check_launch
        with patch.object(D, '_scan', side_effect=AssertionError('HTTP must not hash')):
            self.source.provision(self.request)
            self.source.worker_state.return_value='RUNNING'
            self.assertEqual(self.source.provision(self.request)['state'], 'PROVISIONING')
        self.source.spawn.assert_called_once()
        self.assertEqual(self.source.worker(self.request['opId']), 0)
        self.source.worker_state.return_value='STOPPED'
        with patch.object(D, '_scan', side_effect=AssertionError('issued seal must not rehash')):
            first = self.source.provision(self.request)
            self.assertEqual(first, self.source.provision(self.request))
        self.assertEqual(first['grant']['id'], self.request['opId'])
        self.assertEqual(first['grant']['receipt']['owners'], [USER])

    def test_ready_survives_process_restart_without_issuing_new_grant(self):
        grant = self.provision()
        reopened = M.StorageArchive.from_executor(self.node); reopened.spawn=Mock()
        with patch.object(self.store, 'seal', side_effect=AssertionError('must read existing grant')):
            self.assertEqual(reopened.provision(self.request)['grant'], grant)
        reopened.spawn.assert_not_called()
        self.assertTrue(self.cold._tier('original',self.version)['pins'])

    def test_same_operation_cannot_change_target_owner_or_source(self):
        self.provision()
        self.node.CONFIG['transferPeers']['another-node'] = dict(self.peer)
        with self.assertRaises(ValueError): self.source.provision({**self.request,'targetMachine':'another-node'})
        with self.assertRaises(PermissionError): self.source.provision({**self.request,'userId':'demo-user-2'})
        changed = {**self.request,'source':{**self.request['source'],'dataset':'missing'}}
        with self.assertRaises(FileNotFoundError): self.source.provision(changed)

    def test_single_worker_lane_stays_reserved_for_unknown_or_active_process(self):
        self.source.provision(self.request)
        other = {**self.request,'opId':str(uuid.uuid4())}
        for status in ('RUNNING','UNKNOWN'):
            self.source.worker_state.return_value=status
            self.assertEqual(self.source.provision(other)['state'], 'UNKNOWN')
        self.source.spawn.assert_called_once()
        self.source.worker(self.request['opId'])
        self.source.worker_state.return_value='STOPPED'
        self.assertEqual(self.source.provision(other)['state'], 'PROVISIONING')
        self.assertEqual(self.source.spawn.call_count,2)

    def test_ambiguous_launch_and_stopped_crash_are_never_blindly_retried(self):
        self.source.spawn.side_effect=TimeoutError('ambiguous')
        self.assertEqual(self.source.provision(self.request)['state'],'UNKNOWN')
        self.assertEqual(self.source.provision({**self.request,'retry':True})['state'],'UNKNOWN')
        self.source.spawn.assert_called_once()
        other = {**self.request,'opId':str(uuid.uuid4())}
        self.source.spawn.side_effect=None
        self.assertEqual(self.source.provision(other)['state'],'UNKNOWN')
        self.source.spawn.assert_called_once()  # Ambiguous lane never admits a second job.
        # The original dispatch may actually have reached its worker. Only its
        # definite completion reconciles the lane without private intervention.
        self.assertEqual(self.source.worker(self.request['opId']),0)
        self.source.provision(other)
        self.assertEqual(self.source.provision(other)['state'],'UNKNOWN')
        self.assertEqual(self.source.spawn.call_count,2)

    def test_failed_worker_requires_explicit_retry_stopped_and_keeps_original_seal(self):
        self.source.provision(self.request)
        real = self.source._grant
        with patch.object(self.source, '_grant', side_effect=ValueError('post-seal failure')):
            self.assertEqual(self.source.worker(self.request['opId']),1)
        path = self.store.root/self.request['opId']/'grant.json'
        before = path.read_bytes()
        self.assertEqual(self.source.provision(self.request)['state'],'FAILED')
        self.source.spawn.assert_called_once()
        self.source.worker_state.return_value='RUNNING'
        self.assertEqual(self.source.provision(self.request)['state'],'UNKNOWN')
        self.source.worker_state.return_value='UNKNOWN'
        self.assertEqual(self.source.provision({**self.request,'retry':True})['state'],'UNKNOWN')
        self.source.spawn.assert_called_once()
        self.source.worker_state.return_value='STOPPED'
        self.assertEqual(self.source.provision({**self.request,'retry':True})['state'],'PROVISIONING')
        with patch.object(D, '_scan', side_effect=AssertionError('no reseal of durable grant')):
            self.assertEqual(self.source.worker(self.request['opId']),0)
        self.assertEqual(path.read_bytes(),before)
        self.assertEqual(self.source.provision(self.request)['state'],'READY')

    def test_policy_change_rejects_existing_operation_and_event(self):
        intent = self.intent(); self.source.outbox_begin(intent); self.provision()
        self.node.CONFIG['storageArchive'] = {**POLICY,'authority':'different'}
        changed = M.StorageArchive.from_executor(self.node)
        with self.assertRaises(ValueError): changed.provision(self.request)
        with self.assertRaises(ValueError): changed.outbox_begin(intent)
        self.assertEqual(changed.outbox_list({})['events'],[])

    def test_outbox_intent_reconciles_lost_ready_reply_and_deduplicates_registration(self):
        intent = self.intent(); event = self.source.outbox_begin(intent)
        self.assertEqual(event, {'id':intent['opId']})
        self.assertEqual(self.source.outbox_begin(self.intent()), event)
        # Existing old datasets are NOT discovered; only this persisted intent.
        events = self.source.outbox_list({'limit':8})['events']
        self.assertEqual(events,[dict(id=intent['opId'],userId=USER,dataset='original',version=self.version,state='READY')])
        self.assertEqual(len(self.source._ids(self.source.root/'events')),1)
        self.source.outbox_ack({k:v for k,v in events[0].items() if k!='state'})
        self.assertEqual(self.source.outbox_list({})['events'],[])
        self.assertEqual(self.source.outbox_begin(self.intent()), event)

    def test_publish_before_registration_binds_only_once_and_never_scans_old_ready(self):
        intent = self.intent(dataset='new-dataset'); self.source.outbox_begin(intent)
        self.assertEqual(self.source.outbox_list({})['events'],[])
        self.cold.register_manifest(ADMIN,'new-dataset',self.manifest,[USER])
        self.cold.materialize(ADMIN,'new-dataset',self.version,_source=self.root/'input')
        event = self.source.outbox_list({})['events'][0]
        self.assertEqual(event['dataset'],'new-dataset')
        row = A._load(self.source._event_path(intent['opId']))
        self.assertEqual(row['registration'],list(self.cold._record_identity('new-dataset',self.version)))

    def test_outbox_rotation_prevents_unacked_old_eight_starvation(self):
        for n in range(12):
            dataset='dataset-'+str(n)
            self.cold.register_manifest(ADMIN,dataset,self.manifest,[USER])
            self.cold.materialize(ADMIN,dataset,self.version,_source=self.root/'input')
            self.source.outbox_begin(self.intent(dataset=dataset))
        first = self.source.outbox_list({'limit':8})['events']
        second = self.source.outbox_list({'limit':8})['events']
        self.assertEqual(len({e['id'] for e in first+second}),12)

    def test_outbox_ack_requires_fixed_owner_reference_and_current_registration(self):
        intent=self.intent(); self.source.outbox_begin(intent)
        event=self.source.outbox_list({})['events'][0]; args={k:v for k,v in event.items() if k!='state'}
        for mutation in ({'userId':'demo-user-2'},{'dataset':'different'},{'version':'a'*64}):
            with self.assertRaises(ValueError): self.source.outbox_ack({**args,**mutation})
        self.assertEqual(self.source.outbox_ack(args),self.source.outbox_ack(args))
        self.cold.attach_source(ADMIN,'original',self.version,'input')
        with self.assertRaises(ValueError): self.source.outbox_ack(args)
        new=self.source.outbox_begin(self.intent())
        self.assertNotEqual(new['id'],intent['opId'])

    def test_outbox_concurrent_begins_deduplicate_to_one_intent(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(self.source.outbox_begin,[self.intent(),self.intent()]))
        self.assertEqual(results[0],results[1])
        self.assertEqual(len(self.source._ids(self.source.root/'events')),1)

    def test_original_is_fixed_single_owner_protected_and_not_a_new_seal(self):
        with patch.object(self.store,'seal',side_effect=AssertionError('no HTTP hash')):
            self.assertEqual(self.source.original(dict(userId=USER,**self.request['source'])),
                             dict(protected=True,**self.request['source']))
        with self.assertRaises(PermissionError): self.source.original(dict(userId='demo-user-2',**self.request['source']))

    def test_real_tls_provision_certify_evict_recover_then_idempotent_ack(self):
        grant=self.provision(); target=self.tls_target()
        intent=self.intent(dataset='replica'); event=target.outbox_begin(intent)
        target.outbox_ready(dict(opId=event['id'],userId=USER))
        request=dict(opId=str(uuid.uuid4()),userId=USER,target=dict(dataset='replica',version=self.version),grant=grant)
        result=target.certify(request)
        self.assertEqual(result['state'],'READY'); self.assertEqual(result['role'],'cache')
        self.assertNotIn('grant',result); self.assertNotIn('token',json.dumps(result))
        self.assertEqual(result,target.certify(request))
        self.hot.evict(ADMIN,'replica',self.version)
        # Certify response concerns durable proof, not a demand to copy again.
        self.assertEqual(result,target.certify(request))
        target.outbox_ack(dict(id=event['id'],userId=USER,dataset='replica',version=self.version))
        self.assertEqual(target.tier.recover(ADMIN,'replica',self.version)['state'],'READY')
        actual=self.hot._paths('replica',self.version)['ready']/'data'/'file'
        self.assertEqual(actual.read_bytes(),(self.root/'input'/'file').read_bytes())
        self.assertTrue(all(r['action'] in ('guard','manifest','get') for r in self.read_requests))
        self.assertFalse(target.tier.enabled)

    def test_certify_rejects_wrong_owner_reference_grant_and_keeps_protected(self):
        grant=self.provision(); target=self.tls_target()
        request=dict(opId=str(uuid.uuid4()),userId=USER,target=dict(dataset='replica',version=self.version),grant=grant)
        for changed in ({'userId':'demo-user-2'}, {'grant':{**grant,'targetMachine':'other'}},
                        {'target':{'dataset':'replica','version':'a'*64}}):
            with self.assertRaises((ValueError,PermissionError)): target.certify({**request,**changed})
        bad={**grant,'token':'x'*43}
        with self.assertRaises(ValueError): target.certify({**request,'grant':bad})
        self.assertEqual(self.hot._tier('replica',self.version)['role'],'protected')
        with self.assertRaises(ValueError): target.certify(request)  # ID/grant immutable even on failure.

    def test_certify_failed_reply_retries_same_grant_and_policy_is_fixed(self):
        grant=self.provision(); target=self.tls_target()
        request=dict(opId=str(uuid.uuid4()),userId=USER,target=dict(dataset='replica',version=self.version),grant=grant)
        with patch.object(target.tier,'verify_authority',side_effect=ConnectionError('offline')):
            with self.assertRaises(ConnectionError): target.certify(request)
        self.assertEqual(self.hot._tier('replica',self.version)['role'],'protected')
        self.assertEqual(target.certify({**request,'retry':True})['state'],'READY')
        with self.assertRaises(ValueError): target.certify({**request,'grant':{**grant,'token':'z'*43}})

    def test_explicit_source_certification_uses_separate_durable_namespace(self):
        grant=self.provision();legacy=self.tls_target()
        request=dict(opId=str(uuid.uuid4()),userId=USER,target=dict(dataset='replica',version=self.version),grant=grant)
        # An old in-flight operation with the same UUID is not reinterpreted.
        with patch.object(legacy.tier,'verify_authority',side_effect=ConnectionError('old retry')):
            with self.assertRaises(ConnectionError):legacy.certify(request)
        before={str(path.relative_to(legacy.root)):path.read_bytes() for path in legacy.root.rglob('*') if path.is_file()}
        self.target_node.CONFIG['storageArchive']={'enabled':True,'machine':'other-node','authority':'other-hdd'}
        scoped=M.StorageArchive.from_executor(self.target_node,source_policy=dict(POLICY))
        self.assertNotEqual(scoped.root,legacy.root)
        self.assertEqual(scoped.root.parent.name,'storage-archive-sources')
        with patch.object(scoped.tier,'verify_authority',side_effect=ConnectionError('new retry')):
            with self.assertRaises(ConnectionError):scoped.certify(request)
        recovered=M.StorageArchive.from_executor(self.target_node,source_policy=dict(POLICY))
        result=recovered.certify({**request,'retry':True})
        self.assertEqual(result['state'],'READY')
        self.assertEqual(recovered.certify(request),result)
        self.assertEqual(before,{str(path.relative_to(legacy.root)):path.read_bytes() for path in legacy.root.rglob('*') if path.is_file()})
        self.assertEqual(self.source.provision(self.request)['grant'],grant)
        with self.assertRaises(ValueError):recovered.provision(self.request)
        self.assertEqual(self.hot._tier('replica',self.version)['recovery']['proof'],recovered.remote._proof(grant))

    def test_explicit_source_requires_exact_configuration_and_adapter(self):
        self.tls_target()
        for source in ({'enabled':False}, {**POLICY,'machine':'hot-node'},
                       {**POLICY,'authority':'not-configured'}, {**POLICY,'machine':'not-configured'},
                       {**POLICY,'extra':True}):
            with self.subTest(source=source),self.assertRaises(ValueError):
                M.StorageArchive.from_executor(self.target_node,source_policy=source)
        self.assertFalse((self.target_node.ROOT/'storage-archive-sources').exists())
        old=dict(self.target_node.CONFIG['transferPeers']['cold-node'])
        self.target_node.CONFIG['transferPeers']['cold-node']['certificateSha256']='a'*64
        with self.assertRaisesRegex(ValueError,'adapter'):
            M.StorageArchive.from_executor(self.target_node,source_policy=POLICY)
        self.target_node.CONFIG['transferPeers']['cold-node']=old
        self.target_node.CONFIG['storageAuthorities']['hdd']['unknown']=True
        with self.assertRaises(ValueError):M.StorageArchive.from_executor(self.target_node,source_policy=POLICY)

    def test_default_and_scoped_namespaces_share_the_actual_admission_lock(self):
        legacy=self.tls_target()
        scoped=M.StorageArchive.from_executor(self.target_node,source_policy=dict(POLICY))
        attempted,entered=threading.Event(),threading.Event()
        def enter():
            attempted.set()
            with scoped._lock('admission'):entered.set()
        with ThreadPoolExecutor(max_workers=1) as pool:
            with legacy._lock('admission'):
                future=pool.submit(enter)
                self.assertTrue(attempted.wait(2))
                self.assertFalse(entered.wait(.05))
            future.result(timeout=2)
        self.assertTrue(entered.is_set())

    def test_worker_rejects_changed_peer_policy_before_seal(self):
        self.source.provision(self.request)
        self.node.CONFIG['transferPeers']['hot-node']['certificateSha256']='a'*64
        with patch.object(self.store,'seal',side_effect=AssertionError('must not issue')):
            with self.assertRaisesRegex(ValueError,'peer changed'):
                self.source.worker(self.request['opId'])

    def test_launch_uses_bounded_service_no_shell_or_gpu(self):
        M.StorageArchive.spawn(self.source,self.request['opId'])
        argv=self.node.run.call_args.args[0]
        self.assertEqual(argv[:3],['/usr/bin/systemd-run','--user','--collect'])
        self.assertIn('--property=CPUQuota=100%',argv)
        self.assertIn('--property=MemoryMax=2G',argv)
        self.assertIn('--property=IOWeight=10',argv)
        self.assertIn('--property=RuntimeMaxSec=86400',argv)
        self.assertEqual(argv[-2:],['--storage-archive-worker',self.request['opId']])
        self.assertFalse(any('gpuq-submit' in item or 'bash' in item for item in argv))

    def test_systemd_probe_failures_are_unknown_not_stopped(self):
        for output, code, expected in (
                ('LoadState=loaded\nActiveState=active\nSubState=running\n',0,'RUNNING'),
                ('LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nControlPID=0\n',0,'STOPPED'),
                ('LoadState=not-found\nActiveState=inactive\nMainPID=0\nControlPID=0\n',1,'STOPPED'),
                ('LoadState=loaded\nActiveState=failed\nMainPID=100\nControlPID=0\n',0,'UNKNOWN'),
                ('',1,'UNKNOWN'),
                ('LoadState=loaded\nActiveState=deactivating\n',0,'RUNNING')):
            with patch.object(M.subprocess,'run',return_value=SimpleNamespace(stdout=output,returncode=code)):
                self.assertEqual(M.StorageArchive.worker_state(self.source,self.request['opId']),expected)
        with patch.object(M.subprocess,'run',side_effect=subprocess.TimeoutExpired('systemctl',4)):
            self.assertEqual(M.StorageArchive.worker_state(self.source,self.request['opId']),'UNKNOWN')

    def test_history_bound_denies_new_intent_without_changing_existing(self):
        old=self.intent(); self.source.outbox_begin(old)
        with patch.object(M,'MAX_HISTORY',1):
            self.assertEqual(self.source.outbox_begin(old),{'id':old['opId']})
            with self.assertRaisesRegex(ValueError,'history is full'):
                self.source.outbox_begin(self.intent(dataset='different'))
        self.assertEqual(len(self.source._ids(self.source.root/'events')),1)

    def test_explicit_enrollment_reuses_original_without_outbox_or_copy(self):
        target = self.tls_target()
        source_args = dict(userId=USER, dataset='original', version=self.version)
        target_args = dict(userId=USER, dataset='replica', version=self.version)
        source = self.source.enrollment_check(source_args)
        replica = target.enrollment_check(target_args)
        self.assertEqual(source['manifestSha256'], replica['manifestSha256'])
        self.assertEqual(source['manifestBytes'], replica['manifestBytes'])
        self.assertEqual(self.source._ids(self.source.root/'events'), [])
        self.assertEqual(target._ids(target.root/'events'), [])
        self.request['expectedRegistration'] = source['registration']
        grant = self.provision()
        request = dict(opId=str(uuid.uuid4()), userId=USER,
                       target=dict(dataset='replica', version=self.version), grant=grant,
                       expectedRegistration=replica['registration'])
        self.assertEqual(target.certify(request)['state'], 'READY')
        self.assertEqual(target.certify(request)['state'], 'READY')
        self.assertEqual(self.cold._tier('original', self.version)['role'], 'protected')
        self.assertEqual(self.hot._tier('replica', self.version)['role'], 'cache')
        self.assertEqual(self.hot._dataset(ADMIN, 'replica')['owners'], [USER])

    def test_enrollment_denies_wrong_or_shared_owner_pins_and_staging(self):
        target = self.tls_target()
        args = dict(userId=USER, dataset='replica', version=self.version)
        with self.assertRaises(PermissionError):
            target.enrollment_check({**args, 'userId':'demo-user-2'})
        self.hot.set_owners(ADMIN, 'replica', [USER, 'demo-user-2'])
        with self.assertRaises(PermissionError): target.enrollment_check(args)
        self.hot.set_owners(ADMIN, 'replica', [USER])
        tier = self.hot._tier('replica', self.version)
        tier['pins']['manual'] = dict(owner=USER, createdAt=1)
        self.hot._write_tier('replica', self.version, tier)
        with self.assertRaisesRegex(ValueError, 'Pinned'): target.enrollment_check(args)
        tier['pins'] = {}; self.hot._write_tier('replica', self.version, tier)
        self.hot._paths('replica', self.version)['.staging'].mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'staging'): target.enrollment_check(args)
        self.assertEqual(target._ids(target.root/'events'), [])

    def test_missing_enrollment_probe_is_source_only_explicit_and_metadata_only(self):
        args = dict(userId=USER, dataset='absent', version=self.version)
        with self.assertRaises(FileNotFoundError): self.source.enrollment_check(args)
        self.assertEqual(self.source.enrollment_check({**args, 'allowMissing': True}),
                         dict(protocol=1, machine='cold-node', state='ABSENT', **args))
        self.assertEqual(self.source._ids(self.source.root/'events'), [])
        for flag in [False, 'true', 1]:
            with self.assertRaises(ValueError): self.source.enrollment_check({**args, 'allowMissing':flag})
        with self.assertRaisesRegex(ValueError, 'configured machine'):
            self.tls_target().enrollment_check({**args, 'allowMissing': True})
        self.assertEqual(self.source.enrollment_check(dict(userId=USER, dataset='original',
            version=self.version, allowMissing=True))['state'], 'READY')

    def test_missing_probe_rejects_orphan_state_wrong_owner_and_unknown_io(self):
        args = dict(userId=USER, dataset='absent', version=self.version, allowMissing=True)
        paths = self.cold._paths('absent', self.version)
        for name in ('ready', '.staging', '.leases'):
            path = paths[name]; path.mkdir(parents=True)
            with self.assertRaisesRegex(ValueError, 'protected or unknown'):
                self.source.enrollment_check(args)
            path.rmdir()
        self.cold._write_tier('absent', self.version, self.cold._default_tier())
        with self.assertRaisesRegex(ValueError, 'protected or unknown'): self.source.enrollment_check(args)
        with self.assertRaises(PermissionError):
            self.source.enrollment_check(dict(userId='demo-user-2', dataset='original',
                version='f'*64, allowMissing=True))
        with patch.object(self.cold, '_record_identity', side_effect=OSError('disk unavailable')):
            with self.assertRaisesRegex(OSError, 'disk unavailable'):
                self.source.enrollment_check(dict(userId=USER, dataset='original',
                    version=self.version, allowMissing=True))

    def test_enrollment_fixed_registration_rejects_change_before_provision_or_certify(self):
        target = self.tls_target()
        source = self.source.enrollment_check(dict(userId=USER, dataset='original', version=self.version))
        replica = target.enrollment_check(dict(userId=USER, dataset='replica', version=self.version))
        path = self.cold._paths('original')['.registry']/(self.version+'.json')
        D._write_json(path, D._read_json(path))
        with self.assertRaisesRegex(ValueError, 'registration changed'):
            self.source.provision({**self.request, 'expectedRegistration':source['registration']})
        self.assertEqual(self.source._ids(self.source.root/'events'), [])
        grant = self.provision()
        path = self.hot._paths('replica')['.registry']/(self.version+'.json')
        D._write_json(path, D._read_json(path))
        with self.assertRaisesRegex(ValueError, 'registration changed'):
            target.certify(dict(opId=str(uuid.uuid4()), userId=USER,
                target=dict(dataset='replica', version=self.version), grant=grant,
                expectedRegistration=replica['registration']))
        self.assertEqual(self.hot._tier('replica', self.version)['role'], 'protected')

    def test_enrollment_seal_rehashes_payload_and_does_not_trust_metadata_probe(self):
        source = self.source.enrollment_check(dict(userId=USER, dataset='original', version=self.version))
        request = {**self.request, 'expectedRegistration':source['registration']}
        payload = self.cold._paths('original', self.version)['ready']/'data'/'file'
        os.chmod(payload, 0o600); payload.write_bytes(b'changed after metadata check'); os.chmod(payload, 0o400)
        self.assertEqual(self.source.provision(request)['state'], 'PROVISIONING')
        self.assertEqual(self.source.worker(request['opId']), 1)
        self.assertEqual(self.source.provision(request)['state'], 'FAILED')
        self.assertEqual(self.hot._tier('replica', self.version)['role'], 'protected')

    def test_enrollment_reuses_existing_grant_without_changing_its_request_digest(self):
        grant = self.provision()
        proof = self.source.enrollment_check(dict(userId=USER, dataset='original', version=self.version))
        self.assertEqual(self.source.provision({**self.request,
            'expectedRegistration':proof['registration']})['grant'], grant)
        with self.assertRaisesRegex(ValueError, 'registration changed'):
            self.source.provision({**self.request, 'expectedRegistration':'0'*64})

    def test_enrollment_rechecks_staging_before_dispatch(self):
        proof = self.source.enrollment_check(dict(userId=USER, dataset='original', version=self.version))
        self.cold._paths('original', self.version)['.staging'].mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'staging'):
            self.source.provision({**self.request, 'expectedRegistration':proof['registration']})
        self.source.spawn.assert_not_called()

    def test_safe_private_state_rejects_symlink_and_nonprivate_root(self):
        bad=self.root/'bad-state'; bad.mkdir(); (bad/'storage-archive').symlink_to(self.source.root)
        node=self.executor('cold-node',self.cold,bad)
        node.CONFIG.update(storageAuthority={'enabled':True}); node.storage_authority=lambda:self.store
        with self.assertRaises((ValueError,OSError)): M.StorageArchive(node)
        os.chmod(self.source.root,0o755)
        with self.assertRaises(ValueError): M.StorageArchive(self.node)


if __name__ == '__main__':
    unittest.main()
