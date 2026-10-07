"""Real immutable storage + real pinned TLS, disposable nodes; no GPUs/SSH."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
from http.server import HTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

HERE=Path(__file__).resolve().parent
DEPLOY=HERE.parent/'deploy'
def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
F=module('snapshot_fixture_for_transfers',HERE/'snapshot-sync.test.py')
T=module('transfer_worker_tests',DEPLOY/'transfer-jobs.py')
P=module('transfer_peer_tests',DEPLOY/'transfer-peer.py')
A=module('transfer_archive_tests',DEPLOY/'storage-archive.py')
USER=F.USER


class Transfers(unittest.TestCase):
    def setUp(self):
        self.fixture=F.SnapshotSyncTests();self.fixture.setUp();self.source,self.target=self.fixture.nodes
        self.source.CONFIG['machine']='gpu-1';self.target.CONFIG['machine']='gpu-2'
        for node in (self.source,self.target):
            for name in ('transfer-jobs.py','transfer-peer.py'):shutil.copy2(DEPLOY/name,node.HERE/name)
        # Over two chunks, empty file, Chinese path and an empty directory.
        folder=self.source.HERE/'source';(folder/'sample.txt').write_bytes(b'a'*(2*T.CHUNK+17));(folder/'空.txt').write_bytes(b'');(folder/'empty-directory').mkdir()
        d,c=self.source.dataset_cache();admin=d.Principal('builtin-admin',True)
        self.version=c.register_source(admin,'shared','fixture',[USER])['version'];c.materialize(admin,'shared',self.version)
        self.src=T.TransferJobs(self.source);self.dst=T.TransferJobs(self.target);self.key=str(uuid.uuid4())
        cert,key=self.fixture.root/'cert.pem',self.fixture.root/'key.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-subj','/CN=fixture','-days','1'],check=True,capture_output=True)
        self.source.CONFIG['transferPeer']={'bind':'127.0.0.1','port':18443,'certificate':str(cert),'privateKey':str(key)}
        # Ephemeral port in tests; production configuration requires >=1024.
        self.source.CONFIG['transferPeer']['port']=1024
        with patch.object(P.ThreadingHTTPServer,'server_bind',autospec=True) as bind:
            def ephemeral(server):server.server_address=('127.0.0.1',0);HTTPServer.server_bind(server)
            bind.side_effect=ephemeral
            self.server=P.create_server(self.source,self.src)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        pin=hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest()
        self.target.CONFIG['transferPeers']={'gpu-1':{'address':'127.0.0.1','port':self.server.server_port,'certificateSha256':pin}}
        self.calls=[];self.active=False
        self.patches=[patch.object(self.dst,'activity',side_effect=lambda unit:self.active),patch.object(self.target,'run',side_effect=lambda argv,**kw:self.calls.append(argv)),patch.object(self.target.dataset_uploads(),'active',return_value=True)]
        for p in self.patches:p.start()
        ticket=self.src.prepare({'id':self.key,'reference':{'kind':'datasets','dataset':'shared','version':self.version},'userId':USER,'targetMachine':'gpu-2'})
        self.args={'id':self.key,'userId':USER,'sourceMachine':'gpu-1','source':ticket,'reference':{'kind':'datasets','dataset':'shared','version':self.version},'name':'copied'}
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join(2)
        for p in self.patches:p.stop()
        self.fixture.tearDown()
    def control(self):return {'id':self.key,'userId':USER}
    def test_ssd_budget_rejects_oversize_lan_copy_before_target_upload_or_gc(self):
        self.target.CONFIG['storageTier']={'enabled':True,'budgetBytes':1}
        self.dst.start(self.args)
        source_bytes=(self.source.HERE/'source/sample.txt').read_bytes()
        with patch.object(self.target,'storage_node',side_effect=AssertionError('oversize never collects')), \
                patch.object(self.dst,'upload',side_effect=AssertionError('no target upload admitted')):
            self.assertEqual(self.dst.worker(self.key,1),1)
        result=self.dst.status(self.control())
        self.assertEqual(result['state'],'FAILED');self.assertIn('exceeds cache budget',result['error'])
        uploads=self.target.dataset_uploads()
        self.assertFalse(uploads.folder(USER,self.key).exists())
        self.assertEqual(source_bytes,(self.source.HERE/'source/sample.txt').read_bytes())
        self.assertEqual(self.src.load(self.key,'.source-lease.json')['state'],'HELD')
    def test_lan_worker_preflight_excludes_only_its_exact_validated_target(self):
        self.dst.start(self.args)
        with patch.object(self.target,'dataset_cache_admission',return_value={'evicted':[]}) as admission:
            self.assertEqual(self.dst.worker(self.key,1),0)
        call=admission.call_args
        info=self.args['source']
        self.assertEqual(call.args,(info['totalBytes']+info['manifestBytes']*4+info['entries']*8192+65536,))
        expected='u-'+hashlib.sha256(USER.encode()).hexdigest()[:16]+'-copied'
        self.assertEqual(call.kwargs,{'_exclude':((expected,self.version),)})
    def test_snapshot_adapter_reused_only_inside_one_read(self):
        original=self.src.snapshots;instances=[];checks=[]
        def snapshots():
            value=original();instances.append(value)
            lease,export=value.require_transfer_lease,value.export
            value.require_transfer_lease=lambda *a,**k:(checks.append(('lease',id(value))),lease(*a,**k))[1]
            value.export=lambda op,*a,**k:(checks.append((op,id(value))),export(op,*a,**k))[1]
            return value
        token=self.args['source']['token'];request={**self.control(),'action':'get','path':'sample.txt','offset':2*T.CHUNK+17};request.pop('userId')
        with patch.object(self.src,'snapshots',side_effect=snapshots):
            self.assertTrue(self.src.read(request,token)['eof']);self.assertTrue(self.src.read(request,token)['eof'])
        self.assertEqual(len(instances),2);self.assertIsNot(instances[0],instances[1])
        self.assertEqual([name for name,_ in checks],['lease','datasets.snapshot.info','datasets.snapshot.get']*2)
        self.assertEqual(len({identity for _,identity in checks[:3]}),1)
        self.assertEqual(len({identity for _,identity in checks[3:]}),1)
    def test_snapshot_adapter_is_not_cached_between_concurrent_requests(self):
        other=str(uuid.uuid4());ticket=self.src.prepare({**self.control(),'id':other,'reference':self.args['reference'],'targetMachine':'gpu-2'})
        original=self.src.snapshots;instances=[];guard=threading.Lock()
        def snapshots():
            value=original()
            with guard:instances.append(value)
            return value
        def read(pair):return self.src.read({'id':pair[0],'action':'get','path':'sample.txt','offset':2*T.CHUNK+17},pair[1])
        with patch.object(self.src,'snapshots',side_effect=snapshots),ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(read,[(self.key,self.args['source']['token']),(other,ticket['token'])]))
        self.assertTrue(all(r['eof'] for r in results));self.assertEqual(len(instances),2);self.assertIsNot(instances[0],instances[1])
    def test_snapshot_adapter_still_rechecks_acl_before_payload(self):
        original=self.src.snapshots;d,c=self.source.dataset_cache();record_path=c._paths('shared')['.registry']/'dataset.json'
        def snapshots():
            value=original();export=value.export
            def changed(operation,*args,**kw):
                result=export(operation,*args,**kw)
                if operation=='datasets.snapshot.info':
                    record=json.loads(record_path.read_text());record['owners']=['builtin-admin'];d._write_json(record_path,record)
                return result
            value.export=changed;return value
        with patch.object(self.src,'snapshots',side_effect=snapshots),self.assertRaises(PermissionError):
            self.src.read({'id':self.key,'action':'get','path':'sample.txt','offset':0},self.args['source']['token'])
    def test_snapshot_adapter_still_rechecks_lease_before_payload(self):
        original=self.src.snapshots;d,c=self.source.dataset_cache();journal=self.src.load(self.key,'.source-lease.json')
        def snapshots():
            value=original();export=value.export
            def changed(operation,*args,**kw):
                result=export(operation,*args,**kw)
                if operation=='datasets.snapshot.info':c.release_lease(d.Principal('builtin-admin',True), 'shared',self.version,journal['leaseId'])
                return result
            value.export=changed;return value
        with patch.object(self.src,'snapshots',side_effect=snapshots),self.assertRaisesRegex(ValueError,'Persistent source transfer lease'):
            self.src.read({'id':self.key,'action':'get','path':'sample.txt','offset':0},self.args['source']['token'])
    def test_snapshot_adapter_does_not_bypass_ticket_lease_or_fixed_info(self):
        token=self.args['source']['token'];request={'id':self.key,'action':'get','path':'sample.txt','offset':0}
        with patch.object(self.src,'snapshots') as snapshots:
            with self.assertRaises(ValueError):self.src.read(request,'x'*43)
            with self.assertRaises(ValueError):self.src.read({**request,'_snapshots':{}},token)
            snapshots.assert_not_called()
        original=self.src.snapshots
        def snapshots():
            value=original();export=value.export
            def changed(operation,*args,**kw):
                result=export(operation,*args,**kw)
                if operation=='datasets.snapshot.info':result={**result,'entries':result['entries']+1}
                else:raise AssertionError('payload must not be read after info drift')
                return result
            value.export=changed;return value
        with patch.object(self.src,'snapshots',side_effect=snapshots),self.assertRaisesRegex(ValueError,'Fixed source snapshot changed'):
            self.src.read(request,token)
    def test_cache_busy_retries_only_reads_without_replaying_target_writes(self):
        original_read,original_upload=self.src.read,self.dst.upload
        busy=[0];reads=[];writes=[]
        def read(request,token):
            reads.append((request['action'],request.get('path'),request.get('offset')))
            if request['action']=='get' and request.get('offset')==T.CHUNK and busy[0]<2:
                busy[0]+=1
                raise self.source.DATASET_MODULE.CacheBusy('private-path secret-ticket payload')
            return original_read(request,token)
        def upload(spec,action,**fields):
            if action in ('manifest','chunk'):
                writes.append((action,fields.get('path'),fields['offset']))
            return original_upload(spec,action,**fields)
        self.dst.start(self.args)
        with patch.object(self.src,'read',side_effect=read),patch.object(self.dst,'upload',side_effect=upload), \
                patch.object(T.time,'sleep'),self.assertLogs('gpuq.transfer-peer',level='WARNING') as logs:
            self.assertEqual(self.dst.worker(self.key,1),0)
        result=self.dst.load(self.key,'.result.json')
        self.assertEqual(result['state'],'SUCCEEDED');self.assertEqual(result['retries'],2)
        self.assertEqual(len(writes),len(set(writes)))
        self.assertEqual(sum(action=='get' and offset==T.CHUNK for action,path,offset in reads),3)
        self.assertNotIn('private-path',str(logs.output));self.assertNotIn('secret-ticket',str(logs.output))
        self.assertIn('class=CacheBusy',str(logs.output))
    def test_cache_busy_budget_is_bounded_and_preserves_source_lease(self):
        self.dst.start(self.args)
        error=self.source.DATASET_MODULE.CacheBusy('never expose this message')
        with patch.object(self.src,'read',side_effect=error) as read,patch.object(T.time,'sleep') as sleep, \
                patch.object(self.dst,'upload') as upload,self.assertLogs('gpuq.transfer-peer',level='WARNING'):
            self.assertEqual(self.dst.worker(self.key,1),1)
        self.assertEqual(read.call_count,6);self.assertEqual(sleep.call_count,124);upload.assert_not_called()
        result=self.dst.load(self.key,'.result.json')
        self.assertEqual(result['state'],'PAUSED');self.assertEqual(result['retries'],6)
        self.assertIn('resume the same stopped transfer',result['error'])
        self.assertEqual(self.src.load(self.key,'.source-lease.json')['state'],'HELD')
    def test_authentication_or_nonbusy_503_never_retries(self):
        for status in (403,503):
            with self.subTest(status=status):
                key=str(uuid.uuid4());ticket=self.src.prepare({**self.control(),'id':key,
                    'reference':self.args['reference'],'targetMachine':'gpu-2'})
                self.dst.start({**self.args,'id':key,'source':ticket})
                response={'ok':False,'error':'Snapshot grant or immutable source is unavailable'}
                with patch.object(self.src,'read',side_effect=ValueError('secret-ticket private-path')) as read, \
                        patch.object(P,'_read_error',return_value=(response,status)),patch.object(T.time,'sleep') as sleep:
                    self.assertEqual(self.dst.worker(key,1),1)
                self.assertEqual(read.call_count,1);sleep.assert_not_called()
                result=self.dst.load(key,'.result.json')
                self.assertEqual(result['state'],'FAILED');self.assertEqual(result['retries'],0)
    def test_busy_code_requires_real_cache_class_and_exact_http_status(self):
        class CacheBusy(ValueError):pass
        with self.assertLogs('gpuq.transfer-peer',level='WARNING') as logs:
            payload,status=P._read_error(self.source,CacheBusy('secret-ticket private-path payload'))
        self.assertEqual(status,403);self.assertNotIn('code',payload)
        self.assertNotIn('secret-ticket',str(logs.output));self.assertNotIn('private-path',str(logs.output))
        client=T.PeerClient(self.target.CONFIG['transferPeers']['gpu-1'],self.args['source'])
        for status,code in ((403,'SOURCE_CACHE_BUSY'),(503,'OTHER_BUSY'),(503,None),(200,'SOURCE_CACHE_BUSY')):
            with self.subTest(status=status):
                response=SimpleNamespace(status=status,read=lambda limit:json.dumps({'ok':False,'code':code}).encode())
                connection=SimpleNamespace(request=lambda *a,**k:None,getresponse=lambda:response,close=lambda:None)
                client.connection=connection
                with patch.object(client,'connect'),self.assertRaises(ValueError):client.call('info')
    def test_read_diagnostics_have_only_safe_class_and_source_frames(self):
        self.dst.start(self.args)
        with patch.object(self.source,'platform_root_check',side_effect=ValueError('token /private/customer/file payload')), \
                self.assertLogs('gpuq.transfer-peer',level='WARNING') as logs:
            self.assertEqual(self.dst.worker(self.key,1),1)
        text=' '.join(logs.output)
        self.assertIn('class=ValueError',text);self.assertIn('transfer-peer.py:do_POST:',text)
        for private in ('token','/private/customer/file','payload',self.args['source']['token']):self.assertNotIn(private,text)
    def archive_target(self):
        d,cache=self.target.dataset_cache()
        self.target.CONFIG.update(storageArchive={'enabled':True,'machine':'gpu-2','authority':'hdd'},storageAuthority={'enabled':True})
        store=A.A.AuthorityStore(cache,'gpu-2',self.target.ROOT/'authority-test',principal=d.Principal('builtin-admin',True))
        with patch.object(self.target,'storage_authority',return_value=store):return A.StorageArchive.from_executor(self.target)
    def test_live_peer_rechecks_platform_mount_before_each_read(self):
        client=T.PeerClient(self.target.CONFIG['transferPeers']['gpu-1'],self.args['source'])
        with patch.object(self.source,'platform_root_check',side_effect=ValueError('platform unavailable')), \
                patch.object(self.src,'read') as read:
            with self.assertRaisesRegex(ValueError,'unavailable'):client.call('info')
            read.assert_not_called()
            context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT);context.check_hostname=False;context.verify_mode=ssl.CERT_NONE
            connection=http.client.HTTPSConnection('127.0.0.1',self.server.server_port,context=context,timeout=3)
            try:
                connection.request('GET','/capabilities');response=connection.getresponse()
                self.assertEqual(response.status,503);self.assertFalse(json.loads(response.read())['sourceReady'])
            finally:connection.close()
    def test_real_tls_copy_ready_sha_and_same_cgroup_publication(self):
        started=self.dst.start(self.args);self.assertEqual(started['state'],'UNKNOWN')
        self.assertEqual(self.dst.worker(self.key,1),0)
        result=self.dst.status(self.control());self.assertEqual(result['state'],'SUCCEEDED');self.assertEqual(result['version'],self.version)
        d,c=self.target.dataset_cache();data=c._paths(result['dataset'],self.version)['ready']/'data'
        self.assertEqual((data/'sample.txt').read_bytes(),b'a'*(2*T.CHUNK+17));self.assertEqual((data/'空.txt').read_bytes(),b'');self.assertTrue((data/'empty-directory').is_dir())
        self.assertEqual(len(self.calls),1,'Seal and publish must not create an independent upload service')
        session=self.target.dataset_uploads().load(USER,result['uploadId']);self.assertEqual(session['workerUnit'],self.dst.unit(self.key,1))
        self.assertEqual(self.dst.start(self.args)['state'],'SUCCEEDED');self.assertEqual(len(self.calls),1)
        proof=self.dst.process('transfers.confirm-source-release',self.control())
        self.assertTrue(self.src.process('transfers.release-source',{**self.control(),'confirmation':proof})['released'])
        self.assertEqual(self.source.dataset_cache()[1]._leases('shared',self.version),[])
    def test_large_lan_copy_does_not_enable_or_use_public_vps_relay(self):
        # Lower only the relay boundary, not the payload/manifest/schema checks.
        # Real pinned TLS copies >2 MiB; the ordinary RPC stays denied throughout.
        uploads=self.target.dataset_uploads()
        with patch.dict(uploads.relay_allowed.__globals__, {'RELAY_LIMIT_BYTES':1024}):
            self.dst.start(self.args);spec=self.dst.load(self.key)
            begin={k:spec['source'][k] for k in ('manifestBytes','manifestSha256','totalBytes','entries')}
            self.dst.upload(spec,'begin',key=self.key,name=spec['name'],**begin)
            with self.assertRaisesRegex(ValueError,'no VPS fallback'):
                uploads.process('datasets.upload.manifest',{'userId':USER,'uploadId':self.key,'offset':0,'data':'eA=='})
            with self.assertRaisesRegex(ValueError,'Invalid personal upload'):
                uploads.process('datasets.upload.manifest',{'userId':USER,'uploadId':self.key,'offset':0,'data':'eA==','transport':'lan-peer'})
            self.assertEqual(self.dst.worker(self.key,1),0)
            result=self.dst.status(self.control());self.assertEqual(result['state'],'SUCCEEDED')
            session=uploads.load(USER,self.key)
            self.assertEqual(session['lastConfirmedRoute'],'lan-peer')
            self.assertNotIn('relayAllowed',session)
            with self.assertRaisesRegex(ValueError,'no VPS fallback'):
                uploads.process('datasets.upload.chunk',{'userId':USER,'uploadId':self.key,'path':'sample.txt','offset':0,'data':'eA=='})
        data=self.target.dataset_cache()[1]._paths(result['dataset'],self.version)['ready']/'data'
        self.assertEqual((data/'sample.txt').read_bytes(),b'a'*(2*T.CHUNK+17))
    def test_large_lan_resume_retains_same_upload_and_ordinary_admission(self):
        uploads=self.target.dataset_uploads();original=self.dst.upload;interrupted=[False]
        def upload(spec,action,**fields):
            value=original(spec,action,**fields)
            if action=='chunk' and fields['path']=='sample.txt' and not interrupted[0]:
                interrupted[0]=True;raise ConnectionError('interrupted after acknowledged chunk')
            return value
        with patch.dict(uploads.relay_allowed.__globals__, {'RELAY_LIMIT_BYTES':1024}):
            self.dst.start(self.args)
            with patch.object(self.dst,'upload',side_effect=upload):self.assertEqual(self.dst.worker(self.key,1),1)
            first=uploads.status(USER,{'uploadId':self.key,'path':'sample.txt'})
            self.assertEqual(first['file']['offset'],T.CHUNK)
            self.assertEqual(self.dst.status(self.control())['state'],'PAUSED')
            self.dst.resume(self.control());self.assertEqual(self.dst.worker(self.key,2),0)
            session=uploads.load(USER,self.key)
            self.assertEqual(session['lastConfirmedRoute'],'lan-peer')
            self.assertNotIn('archiveAdmission',session);self.assertNotIn('relayAllowed',session)
            self.assertEqual(self.dst.status(self.control())['uploadId'],self.key)
    def test_legacy_failed_relay_resumes_with_four_ordinary_sessions_and_same_source_lease(self):
        uploads=self.target.dataset_uploads();original=self.dst.upload;blocked=[False]
        def old_worker(spec,action,**fields):
            if action=='manifest' and not blocked[0]:
                blocked[0]=True
                return uploads.process('datasets.upload.manifest',{'userId':USER,**fields})
            return original(spec,action,**fields)
        with patch.dict(uploads.relay_allowed.__globals__, {'RELAY_LIMIT_BYTES':1024}):
            self.dst.start(self.args)
            with patch.object(self.dst,'upload',side_effect=old_worker):self.assertEqual(self.dst.worker(self.key,1),1)
            self.assertEqual(self.dst.status(self.control())['state'],'FAILED')
            self.assertEqual(uploads.load(USER,self.key)['state'],'RECEIVING_MANIFEST')
            retained=[]
            for _ in range(3):
                key=str(uuid.uuid4());uploads.begin(USER,{'name':'retained','key':key,'manifestBytes':100,
                    'manifestSha256':'a'*64,'totalBytes':10,'entries':1});retained.append(key)
            before=[uploads.load(USER,key) for key in retained]
            lease=self.src.load(self.key,'.source-lease.json')
            self.assertEqual(lease['state'],'HELD')
            renewed=self.src.prepare({'id':self.key,'userId':USER,'reference':self.args['reference'],'targetMachine':'gpu-2','renew':True})
            self.assertNotEqual(renewed['token'],self.args['source']['token'])
            self.assertEqual({k:v for k,v in renewed.items() if k!='token'},
                {k:v for k,v in self.args['source'].items() if k!='token'})
            self.assertEqual(self.src.load(self.key,'.source-lease.json')['leaseId'],lease['leaseId'])
            self.dst.resume({**self.control(),'source':renewed})
            self.assertEqual(self.dst.worker(self.key,2),0)
            result=self.dst.status(self.control());self.assertEqual(result['state'],'SUCCEEDED')
            self.assertEqual(result['uploadId'],self.key);self.assertEqual(result['version'],self.version)
            session=uploads.load(USER,self.key)
            for field in ('archiveAdmission','relayAllowed'):self.assertNotIn(field,session)
            self.assertNotIn('archiveLane',self.dst.load(self.key))
            self.assertEqual(session['lastConfirmedRoute'],'lan-peer')
            self.assertEqual([uploads.load(USER,key) for key in retained],before)
            self.assertEqual(self.src.load(self.key,'.source-lease.json')['leaseId'],lease['leaseId'])
            self.assertEqual(self.src.load(self.key,'.source-lease.json')['state'],'HELD')
            proof=self.dst.process('transfers.confirm-source-release',self.control())
            self.assertEqual(proof['attempt'],2)
            self.assertTrue(self.src.process('transfers.release-source',{**self.control(),'confirmation':proof})['released'])
            self.assertEqual(self.source.dataset_cache()[1]._leases('shared',self.version),[])
    def test_lan_ingress_rejects_spec_session_or_cancel_drift_before_writing(self):
        self.dst.start(self.args);spec=self.dst.load(self.key);uploads=self.target.dataset_uploads()
        begin={k:spec['source'][k] for k in ('manifestBytes','manifestSha256','totalBytes','entries')}
        self.dst.upload(spec,'begin',key=self.key,name=spec['name'],**begin)
        fields={'uploadId':self.key,'offset':0,'data':'eA=='}
        with self.assertRaisesRegex(ValueError,'durable transfer'):
            self.dst.upload({**spec,'name':'different'},'manifest',**fields)
        session=uploads.load(USER,self.key);changed={**session,'totalBytes':session['totalBytes']+1};uploads.save(changed)
        with self.assertRaisesRegex(ValueError,'Corrupt personal upload identity|immutable source'):
            self.dst.upload(spec,'manifest',**fields)
        uploads.save(session)
        with self.assertRaisesRegex(ValueError,'durable transfer'):
            self.dst.upload(spec,'manifest',**{**fields,'uploadId':str(uuid.uuid4())})
        self.target.atomic_json(self.dst.path(self.key,'.cancel'),{})
        with self.assertRaises(InterruptedError):self.dst.upload(spec,'manifest',**fields)
        self.assertFalse((uploads.folder(USER,self.key)/'manifest.part').exists())
    def test_trusted_archive_real_tls_copy_with_four_retained_personal_uploads(self):
        d,cache=self.target.dataset_cache();uploads=self.target.dataset_uploads();old=[]
        for _ in range(4):
            key=str(uuid.uuid4());uploads.begin(USER,{'name':'retained','key':key,'manifestBytes':100,
                'manifestSha256':'a'*64,'totalBytes':10,'entries':1});old.append(key)
        before=[uploads.load(USER,key) for key in old]
        archive=self.archive_target()
        with patch.object(self.target,'storage_archive',return_value=archive):
            args={**self.args,'archiveLane':{'schema':1,'targetMachine':'gpu-2','authority':'hdd'}}
            self.dst.start(args);self.assertEqual(self.dst.worker(self.key,1),0)
            result=self.dst.status(self.control());self.assertEqual(result['state'],'SUCCEEDED')
            self.assertEqual(result['version'],self.version)
            session=uploads.load(USER,result['uploadId']);self.assertEqual(session['archiveAdmission']['transferId'],self.key)
            self.assertEqual([uploads.load(USER,key) for key in old],before)
            self.assertEqual(self.dst.start(args)['state'],'SUCCEEDED')
            with self.assertRaisesRegex(ValueError,'cannot change'):self.dst.start(self.args)
            proof=self.dst.process('transfers.confirm-source-release',self.control())
            self.assertTrue(self.src.process('transfers.release-source',{**self.control(),'confirmation':proof})['released'])
            self.assertEqual(self.source.dataset_cache()[1]._leases('shared',self.version),[])
    def test_archive_start_and_worker_recheck_fixed_authority_without_clearing_protection(self):
        args={**self.args,'archiveLane':{'schema':1,'targetMachine':'gpu-2','authority':'hdd'}}
        with self.assertRaisesRegex(ValueError,'fixed protected'):self.dst.start(args)
        self.assertFalse(self.dst.path(self.key).exists())
        # Ordinary transfers retain their ordinary admission and durable spec.
        self.dst.start(self.args);spec=self.dst.load(self.key)
        self.assertNotIn('archiveLane',spec)
        self.assertEqual(self.dst.worker(self.key,1),0)
        self.assertTrue(self.source.dataset_cache()[1]._leases('shared',self.version))
    def test_archive_worker_disabled_after_start_retains_source_protection(self):
        archive=self.archive_target()
        with patch.object(self.target,'storage_archive',return_value=archive):
            args={**self.args,'archiveLane':{'schema':1,'targetMachine':'gpu-2','authority':'hdd'}}
            self.dst.start(args);self.target.CONFIG['storageArchive']={'enabled':False}
            self.assertEqual(self.dst.worker(self.key,1),1)
            result=self.dst.status(self.control());self.assertEqual(result['state'],'FAILED')
            self.assertIn('fixed protected',result['error'])
            self.assertTrue(self.source.dataset_cache()[1]._leases('shared',self.version))
            with self.assertRaises(FileNotFoundError):self.target.dataset_uploads().load(USER,self.key)
            with self.assertRaisesRegex(ValueError,'fixed protected'):self.dst.resume(self.control())
    def test_archive_resume_renews_ticket_without_changing_bound_admission(self):
        archive=self.archive_target()
        with patch.object(self.target,'storage_archive',return_value=archive):
            args={**self.args,'archiveLane':{'schema':1,'targetMachine':'gpu-2','authority':'hdd'}}
            self.dst.start(args);original=self.dst.upload;interrupted=[False]
            def upload(spec,action,**fields):
                value=original(spec,action,**fields)
                if action=='chunk' and not interrupted[0]:interrupted[0]=True;raise ConnectionError('paused after confirmed chunk')
                return value
            with patch.object(self.dst,'upload',side_effect=upload):self.assertEqual(self.dst.worker(self.key,1),1)
            self.assertEqual(self.dst.status(self.control())['state'],'PAUSED')
            before=self.target.dataset_uploads().load(USER,self.key)['archiveAdmission']
            renewed=self.src.prepare({'id':self.key,'userId':USER,'reference':self.args['reference'],'targetMachine':'gpu-2','renew':True})
            self.dst.resume({**self.control(),'source':renewed})
            self.assertEqual(self.dst.worker(self.key,2),0)
            self.assertEqual(self.target.dataset_uploads().load(USER,self.key)['archiveAdmission'],before)
            self.assertEqual(self.dst.load(self.key)['archiveLane'],args['archiveLane'])
    def test_managed_archive_does_not_bypass_four_global_transfer_slots(self):
        archive=self.archive_target()
        with patch.object(self.target,'storage_archive',return_value=archive):
            self.dst.start({**self.args,'archiveLane':{'schema':1,'targetMachine':'gpu-2','authority':'hdd'}})
            for _ in range(3):
                key=str(uuid.uuid4());self.dst.start({**self.args,'id':key,'source':{**self.args['source'],'id':key}})
            key=str(uuid.uuid4())
            with self.assertRaisesRegex(ValueError,'Four'):
                self.dst.start({**self.args,'id':key,'source':{**self.args['source'],'id':key},'archiveLane':{'schema':1,'targetMachine':'gpu-2','authority':'hdd'}})
            slots=self.dst.load('00000000-0000-0000-0000-000000000000','.slots.json')['slots']
            self.assertEqual(len(slots),4)
    def test_lost_launch_occupies_admission_and_no_second_launch(self):
        with patch.object(self.target,'run',side_effect=TimeoutError('uncertain')):
            self.dst.start(self.args)
        self.assertEqual(self.dst.status(self.control())['state'],'UNKNOWN')
        self.dst.start(self.args);self.assertEqual(self.calls,[])
        for _ in range(3):
            args={**self.args,'id':str(uuid.uuid4())};args['source']={**args['source'],'id':args['id']};self.dst.start(args)
        args={**self.args,'id':str(uuid.uuid4())};args['source']={**args['source'],'id':args['id']}
        with self.assertRaisesRegex(ValueError,'Four'):self.dst.start(args)
        with self.assertRaisesRegex(ValueError,'confirmed'):self.dst.resume(self.control())
    def test_interrupted_partial_resumes_same_bytes_after_confirmed_stop(self):
        self.dst.start(self.args)
        original=self.dst.upload;interrupted=[False]
        def upload(spec,action,**fields):
            result=original(spec,action,**fields)
            if action=='chunk' and fields['path']=='sample.txt' and not interrupted[0]:interrupted[0]=True;raise ConnectionError('interrupted after acknowledged chunk')
            return result
        with patch.object(self.dst,'upload',side_effect=upload):self.assertEqual(self.dst.worker(self.key,1),1)
        self.assertEqual(self.dst.status(self.control())['state'],'PAUSED')
        self.dst.resume(self.control());self.assertEqual(self.dst.worker(self.key,2),0)
        self.assertEqual(self.dst.status(self.control())['version'],self.version);self.assertEqual(len(self.calls),2)
    def test_confirmed_dead_worker_recoverable_but_unknown_manager_fenced(self):
        self.dst.start(self.args);self.target.atomic_json(self.dst.path(self.key,'.started-1'),{'attempt':1})
        self.assertEqual(self.dst.status(self.control())['state'],'PAUSED')
        with patch.object(self.dst,'activity',return_value=None):
            self.assertEqual(self.dst.status(self.control())['state'],'UNKNOWN')
            with self.assertRaisesRegex(ValueError,'confirmed'):self.dst.resume(self.control())
        self.dst.resume(self.control());self.assertEqual(self.dst.worker(self.key,2),0)
    def test_cancel_before_start_fences_late_launch_and_keeps_partial(self):
        self.assertEqual(self.dst.cancel(self.control())['state'],'CANCELED')
        with self.assertRaisesRegex(ValueError,'canceled'):self.dst.start(self.args)
        with self.assertRaises(FileNotFoundError):self.dst.resume(self.control())
    def test_live_cancel_cannot_be_mistaken_for_stopped(self):
        self.dst.start(self.args);self.active=True
        self.assertEqual(self.dst.cancel(self.control())['state'],'CANCELING');self.active=False
        self.assertEqual(self.dst.status(self.control())['state'],'CANCELED')
        with self.assertRaisesRegex(ValueError,'Canceled'):self.dst.resume(self.control())
    def test_confirmed_cancel_overrides_old_failure_without_rewriting_history(self):
        self.dst.start(self.args)
        for state in ('FAILED','PAUSED'):
            with self.subTest(state=state):
                result={'attempt':1,'state':state,'error':'old worker failure'}
                self.target.atomic_json(self.dst.path(self.key,'.result.json'),result)
                before=self.dst.path(self.key,'.result.json').read_bytes()
                self.assertEqual(self.dst.cancel(self.control())['state'],'CANCELED')
                self.assertEqual(self.dst.path(self.key,'.result.json').read_bytes(),before)
                proof=self.dst.confirm_source_release(self.control())
                self.assertEqual(proof['state'],'CANCELED');self.assertTrue(proof['confirmedStopped'])
                self.assertTrue(self.source.dataset_cache()[1]._leases('shared',self.version))
        with self.assertRaisesRegex(ValueError,'finalized'):self.dst.resume(self.control())
    def test_cancel_handles_collected_unit_but_still_requires_activity_proof(self):
        self.dst.start(self.args)
        self.target.atomic_json(self.dst.path(self.key,'.result.json'),{'attempt':1,'state':'FAILED'})
        with patch.object(self.target,'run',side_effect=ValueError('Unit is not loaded')):
            for active,expected in ((False,'CANCELED'),(True,'CANCELING'),(None,'UNKNOWN')):
                with self.subTest(active=active):
                    self.active=active;self.assertEqual(self.dst.cancel(self.control())['state'],expected)
                    if active is not False:
                        with self.assertRaisesRegex(ValueError,'confirmed'):
                            self.dst.confirm_source_release(self.control())
        self.assertTrue(self.source.dataset_cache()[1]._leases('shared',self.version))
        self.assertEqual(len(self.calls),1,'Cancellation must never relaunch a transfer')
    def test_cancel_marker_preserves_success_and_ignores_stale_attempt_result(self):
        self.dst.start(self.args)
        self.target.atomic_json(self.dst.path(self.key,'.result.json'),{'attempt':1,'state':'SUCCEEDED'})
        with patch.object(self.target,'run') as stop:
            self.assertEqual(self.dst.cancel(self.control())['state'],'SUCCEEDED');stop.assert_not_called()
        self.target.atomic_json(self.dst.path(self.key,'.cancel'),{'userId':USER})
        self.assertEqual(self.dst.status(self.control())['state'],'SUCCEEDED')
        self.target.atomic_json(self.dst.path(self.key,'.result.json'),{'attempt':2,'state':'SUCCEEDED'})
        self.assertEqual(self.dst.status(self.control())['state'],'CANCELED')
    def test_not_found_activity_requires_complete_quiescent_manager_receipt(self):
        # Exercise the real activity parser, not the fixture's lifecycle mock.
        probe=T.TransferJobs.__new__(T.TransferJobs);probe.n=SimpleNamespace(ENV={})
        unit=self.dst.unit(self.key,1)
        receipt='LoadState=not-found\nActiveState=inactive\nMainPID=0\nControlGroup=\n'
        for code in (0,1):
            with self.subTest(code=code),patch.object(T.subprocess,'run',return_value=SimpleNamespace(returncode=code,stdout=receipt)):
                self.assertIs(probe.activity(unit),False)
        for output,code,expected in ((receipt,2,None),(receipt.replace('MainPID=0\n',''),0,None),
                (receipt.replace('MainPID=0','MainPID=123'),0,True),
                (receipt.replace('ActiveState=inactive','ActiveState=activating'),0,True)):
            with self.subTest(output=output,code=code),patch.object(T.subprocess,'run',return_value=SimpleNamespace(returncode=code,stdout=output)):
                self.assertIs(probe.activity(unit),expected)
        with patch.object(T.subprocess,'run',side_effect=subprocess.TimeoutExpired('systemctl',5)):
            self.assertIsNone(probe.activity(unit))
    def test_pin_auth_ownership_readonly_and_identity_fences(self):
        client=T.PeerClient({**self.target.CONFIG['transferPeers']['gpu-1'],'certificateSha256':'0'*64},self.args['source'])
        with self.assertRaisesRegex(ValueError,'certificate'):client.call('info')
        bad=T.PeerClient(self.target.CONFIG['transferPeers']['gpu-1'],{**self.args['source'],'token':'x'*43})
        with self.assertRaisesRegex(ValueError,'unavailable'):bad.call('info')
        with self.assertRaises(ValueError):self.src.read({'id':self.key,'action':'get','path':'/etc/passwd','offset':0},self.args['source']['token'])
        with self.assertRaises(ValueError):self.src.read({'id':self.key,'action':'info','userId':'builtin-admin'},self.args['source']['token'])
        self.dst.start(self.args)
        with self.assertRaisesRegex(ValueError,'different account'):self.dst.status({'id':self.key,'userId':'demo-user-7'})
        with self.assertRaisesRegex(ValueError,'cannot change'):self.dst.start({**self.args,'name':'changed'})
        with self.assertRaises(ValueError):self.dst.start({**self.args,'source':{**self.args['source'],'totalBytes':-1}})
    def test_source_acl_rechecked_and_file_change_never_ready(self):
        self.dst.start(self.args);d,c=self.source.dataset_cache()
        # Revoke source membership after capability issuance.
        dataset=c._paths('shared')['.registry']/'dataset.json'
        record=json.loads(dataset.read_text());record['owners']=['builtin-admin'];d._write_json(dataset,record)
        self.assertEqual(self.dst.worker(self.key,1),1);self.assertEqual(self.dst.status(self.control())['state'],'FAILED')

    def test_expired_grant_renewal_is_explicit_and_keeps_same_version(self):
        self.dst.start(self.args)
        ticket=self.src.load(self.key,'.ticket.json');ticket['expiresAt']=0;self.source.atomic_json(self.src.path(self.key,'.ticket.json'),ticket)
        self.assertEqual(self.dst.worker(self.key,1),1);self.assertEqual(self.dst.status(self.control())['state'],'FAILED')
        with self.assertRaisesRegex(ValueError,'expired'):self.src.prepare({'id':self.key,'reference':self.args['reference'],'userId':USER,'targetMachine':'gpu-2'})
        renewed=self.src.prepare({'id':self.key,'reference':self.args['reference'],'userId':USER,'targetMachine':'gpu-2','renew':True})
        self.assertNotEqual(renewed['token'],self.args['source']['token']);self.dst.resume({**self.control(),'source':renewed});self.assertEqual(self.dst.worker(self.key,2),0)
        self.assertEqual(self.dst.status(self.control())['version'],self.version)

    def test_capabilities_probe_only_pinned_peers_without_a_ticket(self):
        manager=SimpleNamespace(returncode=0,stdout='Version=fixture-systemd\n')
        # The source daemon and its TLS certificate must both be live/valid.
        self.source.CONFIG['transferPeer']['port']=self.server.server_port
        with patch.object(T.subprocess,'run',return_value=manager):
            target=self.dst.capabilities({'userId':USER})
            self.assertEqual(target,{'protocol':'lan-transfer-v1','enabled':True,'sourceReady':False,'sources':['gpu-1']})
            source=self.src.capabilities({'userId':USER})
            self.assertTrue(source['sourceReady'])
            self.assertNotIn('address',json.dumps(target));self.assertNotIn(self.args['source']['token'],json.dumps(target))
            self.target.CONFIG['transferPeers']['gpu-1']['certificateSha256']='0'*64
            self.assertEqual(self.dst.capabilities({'userId':USER})['sources'],[])
        with self.assertRaises(ValueError):self.dst.capabilities({'userId':USER,'address':'8.8.8.8'})

    def test_capabilities_fail_closed_for_missing_manager_storage_and_bad_config(self):
        with patch.object(T.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout='')):
            result=self.dst.capabilities({'userId':USER});self.assertFalse(result['enabled']);self.assertEqual(result['sources'],[])
        with patch.object(self.target,'dataset_uploads',side_effect=ValueError('storage unavailable')):
            self.assertFalse(self.dst.capabilities({'userId':USER})['enabled'])
        with patch.object(self.source,'dataset_mount_check',side_effect=ValueError('mount changed')):
            self.assertFalse(T.PeerClient(self.target.CONFIG['transferPeers']['gpu-1'],{}).ready())

if __name__=='__main__':unittest.main()
