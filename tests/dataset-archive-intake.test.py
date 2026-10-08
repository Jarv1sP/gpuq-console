import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
from types import SimpleNamespace
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import uuid
import zipfile

DEPLOY=Path(__file__).resolve().parents[1]/'deploy'
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,DEPLOY/file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
D=module('archive_test_cache','dataset-cache.py');U=module('archive_test_upload','dataset-upload.py');A=U.A

def tar_bytes(entries,mode='w'):
    output=io.BytesIO()
    with tarfile.open(fileobj=output,mode=mode) as archive:
        for name,data,kind in entries:
            info=tarfile.TarInfo(name);info.type=kind;info.size=len(data) if kind==tarfile.REGTYPE else 0
            if kind in (tarfile.SYMTYPE,tarfile.LNKTYPE): info.linkname='../outside'
            archive.addfile(info,io.BytesIO(data))
    return output.getvalue()

class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.cache=D.DatasetCache(self.root/'cache',reserve_bytes=0)
        self.events=[]
        def workspace(user):
            if not re.fullmatch(r'(builtin-admin|demo-user-[0-9]{1,18})',user): raise ValueError('Invalid identity')
        self.node=SimpleNamespace(CONFIG={'machine':'warehouse','datasets':{'uploads':{'maxActiveUploads':32},'archiveUpload':{'enabled':True,'maxExpandedBytes':1024**2,'maxEntries':20}},'storageArchive':{'enabled':True,'machine':'warehouse','authority':'hdd'},'storageAuthority':{'enabled':True}},dataset_cache=lambda:(D,self.cache),workspace=workspace,HERE=DEPLOY,ENV={},run=lambda *a,**k:None,storage_archive=lambda:SimpleNamespace(outbox_begin=lambda args:(self.events.append(args) or {'id':args['opId']}),outbox_ready=lambda args:self.events.append(args)))
        self.u=U.DatasetUploads(self.node);self.user='demo-user-1';self.upload=str(uuid.uuid4());self.intent=str(uuid.uuid4())
        active=patch.object(self.u,'active',return_value=True);active.start();self.addCleanup(active.stop)
    def begin(self,raw,filename='sample.tar',format='tar'):
        archive={'protocol':1,'fileName':filename,'format':format,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
        manifest={'schema':1,'directories':[],'files':[{'path':filename,'size':len(raw),'sha256':archive['sha256']}]}
        content=json.dumps(manifest,separators=(',',':'),ensure_ascii=False).encode()
        self.spec={'name':'sample','manifestBytes':len(content),'manifestSha256':hashlib.sha256(content).hexdigest(),'totalBytes':len(raw),'entries':1,'archive':archive}
        self.args={'userId':self.user,'hostAdmin':False,'protocol':U.ADMISSION_PROTOCOL,'intentKey':self.intent,'uploadId':self.upload,'requestedMachine':'training','storageMachine':'warehouse','authority':'hdd','specification':self.spec,'specificationSha256':hashlib.sha256(json.dumps(self.spec,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()}
        receipt=self.u.admit(self.args);self.assertEqual(receipt['uploadId'],self.upload)
        self.u.manifest_bytes(self.user,{'uploadId':self.upload},0,content,transport='campus-direct')
        session=self.u.load(self.user,self.upload);session.update(state='SEALING',action='seal');self.u.save(session)
        self.assertEqual(self.u.worker(self.user,self.upload,'seal'),0)
        self.assertNotIn('dataset',self.u.load(self.user,self.upload),'Compressed archive is never registered as a dataset')
        return raw
    def chunk(self,raw,offset=0): return self.u.chunk_bytes(self.user,{'uploadId':self.upload,'path':self.spec['archive']['fileName']},offset,raw,transport='campus-direct',direct_chunk_limit=D.CHUNK_BYTES,direct_authorize=lambda:None)
    def commit(self):
        session=self.u.load(self.user,self.upload);session.update(state='PUBLISHING',action='commit');self.u.save(session)
        return self.u.worker(self.user,self.upload,'commit')
    def test_tar_gzip_zip_publish_only_extracted_verified_fixed_version(self):
        for format,filename in [('tar','sample.tar'),('tar.gz','sample.tgz'),('zip','sample.zip')]:
            with self.subTest(format=format):
                self.upload=str(uuid.uuid4());self.intent=str(uuid.uuid4())
                if format=='zip':
                    output=io.BytesIO()
                    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive: archive.writestr('训练/data.txt',b'abc')
                    raw=output.getvalue()
                else: raw=tar_bytes([('训练/data.txt',b'abc',tarfile.REGTYPE)],'w:gz' if format=='tar.gz' else 'w')
                self.begin(raw,filename,format);self.chunk(raw);self.assertEqual(self.commit(),0,self.u.load(self.user,self.upload))
                session=self.u.load(self.user,self.upload);self.assertEqual(session['state'],'READY',session);self.assertEqual(session.get('archivePhase'),'READY')
                manifest={'schema':1,'directories':['训练'],'files':[{'path':'训练/data.txt','size':3,'sha256':hashlib.sha256(b'abc').hexdigest()}]}
                self.assertEqual(session['version'],D._version(manifest));self.assertNotEqual(session['version'],self.spec['manifestSha256'])
                self.assertEqual((self.cache._paths(session['dataset'],session['version'])['ready']/'data/训练/data.txt').read_bytes(),b'abc')
                self.assertFalse(self.u.archive.file(session).exists());self.assertEqual(self.u.admit(self.args)['state'],'READY')
    def test_archive_capacity_uses_read_only_pre_admission_specification(self):
        raw=self.begin(tar_bytes([('data',b'abc',tarfile.REGTYPE)]))
        reader=U.DatasetUploads.__new__(U.DatasetUploads);reader.n,reader.d,reader.cache=self.node,D,self.cache
        reader.limits=U.upload_limits(self.node.CONFIG)
        before=sorted(str(path.relative_to(self.root)) for path in self.root.rglob('*'))
        result=reader.capacity('hdd',self.spec)
        self.assertEqual(result['specificationSha256'],self.args['specificationSha256'])
        self.assertEqual(result['requiredBytes'],self.u.load(self.user,self.upload)['reserveBytes'])
        self.assertEqual(before,sorted(str(path.relative_to(self.root)) for path in self.root.rglob('*')))

    def test_confirmed_offsets_duplicate_ack_and_same_uuid_only(self):
        raw=self.begin(tar_bytes([('data',b'abc',tarfile.REGTYPE)]));half=len(raw)//2
        result=self.chunk(raw[:half]);self.assertEqual(result['offset'],half)
        self.assertEqual(self.chunk(raw[:half])['offset'],half)
        self.assertEqual(self.u.status(self.user,{'uploadId':self.upload,'path':'sample.tar'})['file']['offset'],half)
        with self.assertRaises(ValueError):self.chunk(b'bad',0)
        with self.assertRaises(FileNotFoundError):self.u.status('demo-user-2',{'uploadId':self.upload})
        with self.assertRaises(ValueError):self.u.admit({**self.args,'intentKey':str(uuid.uuid4())})
        self.chunk(raw[half:],half);self.assertEqual(self.commit(),0,self.u.load(self.user,self.upload))
    def test_malicious_tar_paths_links_and_devices_never_publish(self):
        for name,kind in [('/absolute',tarfile.REGTYPE),('../escape',tarfile.REGTYPE),('a/../escape',tarfile.REGTYPE),('link',tarfile.SYMTYPE),('hard',tarfile.LNKTYPE),('dev',tarfile.CHRTYPE),('pipe',tarfile.FIFOTYPE)]:
            with self.subTest(name=name,kind=kind):
                self.upload=str(uuid.uuid4());self.intent=str(uuid.uuid4());raw=self.begin(tar_bytes([(name,b'bad',kind)]));self.chunk(raw)
                self.assertEqual(self.commit(),1);session=self.u.load(self.user,self.upload);self.assertEqual(session['reasonCode'],'ARCHIVE_UNSAFE_PATH');self.assertNotIn('version',session)
        self.assertFalse((self.root/'escape').exists())
    def test_zip_symlink_and_traversal_refused(self):
        for name,mode in [('../escape',0o100600),('link',0o120777),('device',0o020600)]:
            self.upload=str(uuid.uuid4());self.intent=str(uuid.uuid4());output=io.BytesIO();info=zipfile.ZipInfo(name);info.create_system=3;info.external_attr=mode<<16
            with zipfile.ZipFile(output,'w') as archive:archive.writestr(info,b'../outside')
            raw=self.begin(output.getvalue(),'sample.zip','zip');self.chunk(raw);self.assertEqual(self.commit(),1);self.assertEqual(self.u.load(self.user,self.upload)['reasonCode'],'ARCHIVE_UNSAFE_PATH')
    def test_expanded_size_and_count_limits(self):
        for limits, entries in [({'maxExpandedBytes':2}, [('data',b'abc',tarfile.REGTYPE)]), ({'maxEntries':1}, [('a',b'a',tarfile.REGTYPE),('b',b'b',tarfile.REGTYPE)])]:
            self.upload=str(uuid.uuid4());self.intent=str(uuid.uuid4())
            self.node.CONFIG['datasets']['archiveUpload']={'enabled':True,**limits}
            raw=self.begin(tar_bytes(entries));self.chunk(raw);self.assertEqual(self.commit(),1)
            self.assertEqual(self.u.load(self.user,self.upload)['reasonCode'],'ARCHIVE_TOO_LARGE')
    def test_inspection_metadata_is_bounded_before_building_a_large_manifest(self):
        path=self.root/'metadata.tar';path.write_bytes(tar_bytes([('long/'+'x'*80,b'abc',tarfile.REGTYPE)]))
        with self.assertRaises(A.ArchiveError) as rejected: A.inspect_archive(path,'tar',100,20,max_metadata=128)
        self.assertEqual(rejected.exception.reasonCode,'ARCHIVE_TOO_LARGE')
    def test_empty_and_unbounded_zip_compression_are_refused(self):
        output=io.BytesIO()
        with zipfile.ZipFile(output,'w',zipfile.ZIP_BZIP2) as archive: archive.writestr('data',b'abc')
        for raw,filename,format,reason in [(tar_bytes([]),'sample.tar','tar','ARCHIVE_EMPTY'),(output.getvalue(),'sample.zip','zip','ARCHIVE_FORMAT_UNSUPPORTED')]:
            self.upload=str(uuid.uuid4());self.intent=str(uuid.uuid4());self.begin(raw,filename,format);self.chunk(raw)
            self.assertEqual(self.commit(),1);self.assertEqual(self.u.load(self.user,self.upload)['reasonCode'],reason)
    def test_append_crash_recovers_original_uuid_and_confirmed_offset(self):
        raw=self.begin(tar_bytes([('data',b'abc',tarfile.REGTYPE)]));half=len(raw)//2
        write=self.u.d._write_json;reservation=self.u.reservation(self.user,self.upload)
        def interrupt(path,value):
            if path==reservation: raise OSError('controlled crash after file fsync')
            return write(path,value)
        with patch.object(self.u.d,'_write_json',side_effect=interrupt):
            with self.assertRaises(OSError): self.chunk(raw[:half])
        self.assertEqual(self.u.status(self.user,{'uploadId':self.upload,'path':'sample.tar'})['file']['offset'],half)
        self.chunk(raw[half:],half);self.assertEqual(self.commit(),0,self.u.load(self.user,self.upload))
        self.assertEqual(self.u.load(self.user,self.upload)['uploadId'],self.upload)
    def test_expanded_uploads_remain_within_existing_principal_budget(self):
        raw=self.begin(tar_bytes([('data',b'a'*100000,tarfile.REGTYPE)]));self.chunk(raw)
        self.u.limits['maxUserBytes']=self.u.load(self.user,self.upload)['reserveBytes']+190000
        self.assertEqual(self.commit(),0,self.u.load(self.user,self.upload))
        self.upload=str(uuid.uuid4());self.intent=str(uuid.uuid4())
        other=tar_bytes([('data',b'abc',tarfile.REGTYPE)])
        with self.assertRaisesRegex(ValueError,'storage quota'): self.begin(other)
    def test_corrupt_archive_and_compressed_digest_refused(self):
        raw=self.begin(b'broken');self.chunk(raw);self.assertEqual(self.commit(),1);self.assertEqual(self.u.load(self.user,self.upload)['reasonCode'],'ARCHIVE_CORRUPT')
    def test_campus_only_and_node_capability_gate(self):
        self.assertIsNotNone(self.u.archive.capability());self.node.CONFIG['datasets'].pop('archiveUpload');self.assertIsNone(self.u.archive.capability())
        self.node.CONFIG['datasets']['archiveUpload']={'enabled':True}
        raw=self.begin(tar_bytes([('data',b'abc',tarfile.REGTYPE)]))
        for transport in ('vps-relay','tail-upload','lan-peer'):
            with self.assertRaises(A.ArchiveError):self.u.chunk_bytes(self.user,{'uploadId':self.upload,'path':'sample.tar'},0,raw,transport=transport)
        self.assertEqual(self.u._size(self.u.archive.file(self.u.load(self.user,self.upload))),0)
    def test_archive_enable_keeps_existing_directory_uuid_but_rejects_new_directory(self):
        policy=self.node.CONFIG['datasets'].pop('archiveUpload')
        content=b'{"schema":1,"directories":[],"files":[]}'
        spec={'name':'legacy','manifestBytes':len(content),'manifestSha256':hashlib.sha256(content).hexdigest(),'totalBytes':0,'entries':0}
        args={'userId':self.user,'hostAdmin':False,'protocol':U.ADMISSION_PROTOCOL,'intentKey':self.intent,'uploadId':self.upload,'requestedMachine':'training','storageMachine':'warehouse','authority':'hdd','specification':spec,'specificationSha256':hashlib.sha256(json.dumps(spec,separators=(',',':')).encode()).hexdigest()}
        receipt=self.u.admit(args);self.assertEqual(receipt['uploadId'],self.upload)
        self.node.CONFIG['datasets']['archiveUpload']=policy
        self.assertEqual(self.u.admit(args)['uploadId'],self.upload)
        with self.assertRaises(A.ArchiveError): self.u.admit({**args,'uploadId':str(uuid.uuid4()),'intentKey':str(uuid.uuid4())})
    def test_low_disk_denies_before_extraction_and_keeps_original_uuid(self):
        raw=self.begin(tar_bytes([('data',b'abc',tarfile.REGTYPE)]));self.chunk(raw)
        with patch.object(self.cache,'_free',side_effect=ValueError('Insufficient warehouse space')):self.assertEqual(self.commit(),1)
        session=self.u.load(self.user,self.upload);self.assertEqual(session['uploadId'],self.upload);self.assertFalse(self.u.archive.work(session).exists());self.assertNotIn('version',session)

if __name__=='__main__': unittest.main()
