"""Real pinned TLS + immutable cache end-to-end; disposable local trees only."""
import base64
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
import unittest
from unittest.mock import patch
import uuid

SPEC = importlib.util.spec_from_file_location('authority_tests',Path(__file__).resolve().parents[1]/'deploy/storage-authority.py')
A = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(A)
D = A.D
ADMIN = D.Principal('authority-admin',True)
OWNER = D.Principal('owner')


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name).resolve()
        source = self.root/'approved'; source.mkdir()
        (source/'数据.bin').write_bytes(b'protected data\x00'*(A.CHUNK//10+1))
        (source/'empty').mkdir(); (source/'zero').write_bytes(b'')
        self.cold = D.DatasetCache(self.root/'cold',sources={'source':source},reserve_bytes=0)
        self.hot = D.DatasetCache(self.root/'hot',sources={},reserve_bytes=0)
        self.version = self.cold.register_source(ADMIN,'shared','source',[OWNER.user_id])['version']
        self.cold.materialize(ADMIN,'shared',self.version)
        manifest = self.cold.export_manifest(ADMIN,'shared',self.version)['manifest']
        self.hot.register_manifest(ADMIN,'replica',manifest,[OWNER.user_id])
        self.store = A.AuthorityStore(self.cold,'source-node',self.root/'authority',principal=ADMIN)
        self.grant_id = str(uuid.uuid4())
        self.grant = self.store.seal(ADMIN,'shared',self.version,self.grant_id,'target-node')
        cert, key = self.root/'certificate.pem', self.root/'key.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),
                        '-out',str(cert),'-subj','/CN=authority-fixture','-days','1'],check=True,capture_output=True)
        self.requests = []; store = self.store; requests = self.requests
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(inner):
                try:
                    if inner.path != '/authority': raise ValueError('wrong endpoint')
                    payload = json.loads(inner.rfile.read(int(inner.headers['Content-Length'])))
                    requests.append(payload)
                    value = store.read(payload,inner.headers.get('Authorization','')[7:])
                    data, status = {'ok':True,'result':value},200
                except Exception:
                    data, status = {'ok':False,'error':'authority refused'},403
                raw = json.dumps(data).encode(); inner.send_response(status)
                inner.send_header('Content-Length',str(len(raw))); inner.end_headers(); inner.wfile.write(raw)
        self.server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(cert,key)
        self.server.socket = context.wrap_socket(self.server.socket,server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
        pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest()
        self.peer = {'address':'127.0.0.1','port':self.server.server_port,'certificateSha256':pin}
        self.remote = A.RemoteAuthority('source-node',self.peer,self.root/'grants'/'hdd',target_machine='target-node')
        self.remote.install_grant(self.grant)
        self.proof = self.remote.seal(ADMIN,'shared',self.version,'authority-target-cache')
        self.tier = A.T.DatasetTier(self.hot,authorities={'hdd':self.remote},enabled=True,budget_bytes=1)

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(2)
        for folder,_,files in os.walk(self.root):
            os.chmod(folder,0o700)
            for name in files:
                path = Path(folder)/name
                if not path.is_symlink(): os.chmod(path,0o600)
        self.tmp.cleanup()

    def copy(self):
        return self.remote.recover(ADMIN,self.proof,self.hot,'replica',validate_target=lambda:None)

    def certify(self):
        self.copy()
        self.tier.verify_authority(ADMIN,'replica',self.version,'hdd','shared')

    def request(self, action, **fields):
        return {'id':self.grant_id,'action':action,'dataset':'shared','version':self.version,
                'targetMachine':'target-node',**fields}

    def test_seal_copy_mark_cache_evict_recover_same_hash_with_no_source_id(self):
        self.certify()
        self.assertIsNone(self.hot._record(ADMIN,'replica',self.version)['sourceId'])
        with (patch.object(A.T,'_readonly_tree',side_effect=AssertionError('guard must not scan authority')),
              patch.object(D,'_scan',wraps=D._scan) as scan):
            plan = self.tier.plan(ADMIN); self.assertEqual(len(plan['candidates']),1)
            self.assertEqual(scan.call_count,0)
            self.assertEqual(len(self.tier.collect(ADMIN,dry_run=False)['evicted']),1)
        self.assertNotEqual(self.hot.status(OWNER,'replica',self.version)['state'],'READY')
        result = self.tier.recover(ADMIN,'replica',self.version)
        self.assertEqual(result['state'],'READY')
        actual = self.hot._paths('replica',self.version)['ready']/'data'
        original = self.cold._paths('shared',self.version)['ready']/'data'
        self.assertEqual(hashlib.sha256((actual/'数据.bin').read_bytes()).hexdigest(),hashlib.sha256((original/'数据.bin').read_bytes()).hexdigest())
        self.assertTrue((actual/'empty').is_dir()); self.assertEqual((actual/'zero').read_bytes(),b'')
        self.assertFalse((actual/'数据.bin').stat().st_mode&0o222)
        self.assertTrue(all(request['action'] in ('guard','manifest','get') for request in self.requests))

    def test_seal_is_admin_only_idempotent_and_does_not_rehash_existing_grant(self):
        with self.assertRaises(PermissionError): self.store.seal(OWNER,'shared',self.version,str(uuid.uuid4()),'target-node')
        with patch.object(D,'_scan',side_effect=AssertionError('must not rehash an issued grant')):
            self.assertEqual(self.store.seal(ADMIN,'shared',self.version,self.grant_id,'target-node'),self.grant)
        with self.assertRaises(ValueError): self.store.seal(ADMIN,'shared',self.version,self.grant_id,'another-target')

    def test_wrong_certificate_is_rejected_before_sending_capability(self):
        client = A.AuthorityClient({**self.peer,'certificateSha256':'0'*64},self.grant)
        before = len(self.requests)
        with self.assertRaisesRegex(ValueError,'certificate'): client.call('guard')
        self.assertEqual(len(self.requests),before)

    def test_wrong_token_reference_target_and_mutations_are_rejected(self):
        for grant in ({**self.grant,'token':'x'*43},{**self.grant,'dataset':'other'},
                      {**self.grant,'version':'a'*64},{**self.grant,'targetMachine':'other'}):
            with self.assertRaises(ValueError): A.AuthorityClient(self.peer,grant).call('guard')
        for action in ('seal','unpin','delete','release','recover'):
            with self.assertRaises(ValueError): A.AuthorityClient(self.peer,self.grant).call(action)
        for path in ('../outside','/etc/passwd','not-in-manifest'):
            with self.assertRaises(ValueError): A.AuthorityClient(self.peer,self.grant).call('get',path=path,offset=0)

    def test_permanent_pin_freezes_acl_registration_and_deletion(self):
        for operation in (lambda:self.cold.unpin(ADMIN,'shared',self.version,self.grant['receipt']['pinId']),
                          lambda:self.cold.set_owners(ADMIN,'shared',['other']),
                          lambda:self.cold.evict(ADMIN,'shared',self.version),
                          lambda:self.cold.unregister(ADMIN,'shared',self.version)):
            with self.assertRaises(D.CacheError): operation()
        self.assertEqual(self.store.read(self.request('guard'),self.grant['token']),self.grant['receipt'])

    def test_missing_pin_or_out_of_band_acl_change_keeps_cache(self):
        self.certify()
        with self.cold._locked():
            tier = self.cold._tier('shared',self.version); tier['pins']={}; self.cold._write_tier('shared',self.version,tier)
        self.assertEqual(self.tier.plan(ADMIN)['candidates'],[])
        self.assertEqual(self.tier.collect(ADMIN,dry_run=False)['evicted'],[])
        self.assertEqual(self.hot.status(OWNER,'replica',self.version)['state'],'READY')

    def test_offline_source_and_changed_grant_cannot_authorize_gc(self):
        self.certify()
        with patch.object(A.AuthorityClient,'connect',side_effect=ConnectionError('offline')):
            self.assertEqual(self.tier.plan(ADMIN)['candidates'],[])
        with self.assertRaisesRegex(ValueError,'replaced'):
            self.remote.install_grant({**self.grant,'token':'z'*43})
        with self.assertRaises(ValueError):
            with self.remote.guard(ADMIN,{**self.proof,'receiptSha256':'0'*64}): pass
        self.assertEqual(self.hot.status(OWNER,'replica',self.version)['state'],'READY')

    def test_cannot_certify_a_cache_as_an_authority_or_create_a_cycle(self):
        self.certify()
        other = A.AuthorityStore(self.hot,'target-node',self.root/'other-authority',principal=ADMIN)
        with self.assertRaisesRegex(D.CacheError,'protected original'):
            other.seal(ADMIN,'replica',self.version,str(uuid.uuid4()),'source-node')

    def test_recovery_interruption_keeps_partial_and_resumes_without_ready_until_verified(self):
        original = self.store.read; count = [0]
        def interrupt(request,token):
            if request['action']=='get' and request['path']=='数据.bin':
                count[0]+=1
                if count[0]==2: raise ConnectionError('synthetic interruption')
            return original(request,token)
        with patch.object(self.store,'read',side_effect=interrupt):
            with self.assertRaises(ValueError): self.copy()
        self.assertNotEqual(self.hot.status(OWNER,'replica',self.version)['state'],'READY')
        stage = self.hot._paths('replica',self.version)['.staging']/'data'/'数据.bin'
        offset = stage.stat().st_size; self.assertGreater(offset,0)
        self.requests.clear(); self.copy()
        self.assertTrue(any(r['action']=='get' and r.get('path')=='数据.bin' and r['offset']==offset for r in self.requests))
        self.assertEqual(self.hot.status(OWNER,'replica',self.version)['state'],'READY')

    def test_changed_target_receipt_and_bad_payload_never_publish_ready(self):
        with self.assertRaisesRegex(ValueError,'target changed'):
            self.remote.recover(ADMIN,self.proof,self.hot,'replica',validate_target=lambda:(_ for _ in ()).throw(ValueError('target changed')))
        original = self.store.read
        def corrupt(request,token):
            result = original(request,token)
            if request['action']=='get' and request['path']=='数据.bin':
                result['data'] = base64.b64encode(b'x'*len(base64.b64decode(result['data']))).decode()
            return result
        with patch.object(self.store,'read',side_effect=corrupt):
            with self.assertRaisesRegex(D.CacheError,'checksum'): self.copy()
        self.assertNotEqual(self.hot.status(OWNER,'replica',self.version)['state'],'READY')

    def test_simultaneous_grant_install_never_replaces_the_winner(self):
        remote = A.RemoteAuthority('source-node',self.peer,self.root/'race-grants',target_machine='target-node')
        barrier = threading.Barrier(2)
        def install(grant):
            barrier.wait(5)
            try: remote.install_grant(grant); return True
            except ValueError: return False
        grants = [self.grant,{**self.grant,'token':'z'*43}]
        with ThreadPoolExecutor(max_workers=2) as pool:
            successes = list(pool.map(install,grants))
        self.assertEqual(sum(successes),1)
        self.assertEqual(remote._grant('shared',self.version),grants[successes.index(True)])

    def test_issued_grant_missing_seal_never_reissues_or_rotates_token(self):
        path = self.store.root/self.grant_id/'sealed.json'; path.unlink()
        with patch.object(self.store.local,'seal',side_effect=AssertionError('must not reissue')):
            with self.assertRaises(FileNotFoundError):
                self.store.seal(ADMIN,'shared',self.version,self.grant_id,'target-node')
        self.assertEqual(A._load(self.store.root/self.grant_id/'grant.json'),self.grant)

    def test_out_of_band_acl_change_fails_closed(self):
        self.certify()
        registry = self.cold._paths('shared')['.registry']/'dataset.json'
        D._write_json(registry,{'schema':D.SCHEMA,'owners':['different-owner']})
        self.assertEqual(self.tier.plan(ADMIN)['candidates'],[])
        self.assertEqual(self.hot.status(OWNER,'replica',self.version)['state'],'READY')

    def test_bad_manifest_is_rejected_before_target_staging(self):
        original = self.store.read
        def corrupt(request,token):
            result = original(request,token)
            if request['action']=='manifest':
                result['data'] = base64.b64encode(b'x'*len(base64.b64decode(result['data']))).decode()
            return result
        with patch.object(self.store,'read',side_effect=corrupt):
            with self.assertRaisesRegex(ValueError,'manifest checksum'): self.copy()
        self.assertFalse(self.hot._paths('replica',self.version)['.staging'].exists())

    def test_unsafe_private_grant_permissions_and_symlink_root_are_rejected(self):
        file = self.remote._path('shared',self.version); os.chmod(file,0o644)
        with self.assertRaisesRegex(ValueError,'private authority receipt'):
            self.remote.seal(ADMIN,'shared',self.version,'authority-test')
        alias = self.root/'grant-link'; alias.symlink_to(self.remote.root,target_is_directory=True)
        with self.assertRaises(OSError):
            A.RemoteAuthority('source-node',self.peer,alias,target_machine='target-node')

    def test_parallel_recovery_deduplicates_payload_under_target_version_lock(self):
        before = len(self.requests)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _:self.copy(),range(2)))
        self.assertTrue(all(result['state']=='READY' for result in results))
        gets = [r for r in self.requests[before:] if r['action']=='get']
        self.assertEqual(len(gets),3)  # 2 nonempty chunks plus one empty file.

    def test_recovery_uses_shared_batched_accounting_not_a_write_per_chunk(self):
        writes = []; original = D._write_json
        def write(path,value,*args,**kwargs):
            if path.name=='TRANSFER.json': writes.append(dict(value))
            return original(path,value,*args,**kwargs)
        # Make the time trigger deterministic while preserving normal 64 MiB /
        # 256-file batch thresholds. One final accounting update for 3 chunks.
        with patch.object(D,'_write_json',side_effect=write), patch.object(D,'TRANSFER_BATCH_SECONDS',1000):
            self.copy()
        self.assertEqual(len(writes),3)  # create, conservative plan, final batch.
        self.assertEqual(writes[-1]['remainingBytes'],0)


if __name__=='__main__': unittest.main()
