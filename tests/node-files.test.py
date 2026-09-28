"""Workspace boundary regression tests, no remote host or GPU required."""
import base64,importlib.util,json,os,shutil,tempfile,unittest
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path

class Files(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();base=Path(self.temp.name)
        shutil.copy2(Path(__file__).resolve().parents[1]/'deploy/node-executor.py',base/'node.py')
        (base/'node-config.json').write_text(json.dumps({'root':str(base/'data')}))
        spec=importlib.util.spec_from_file_location('node_test',base/'node.py');self.node=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.node)
        self.root=self.node.workspace('demo-user-1')
    def tearDown(self):self.temp.cleanup()
    def call(self,op,path='.',**kwargs):return self.node.file_op('files.'+op,dict(userId='demo-user-1',path=path,**kwargs))
    def test_roundtrip_chunks_and_offsets(self):
        self.call('put','code/test.py',data=base64.b64encode(b'hello').decode(),truncate=True)
        self.call('put','code/test.py',data=base64.b64encode(b'world').decode(),offset=5)
        r=self.call('get','code/test.py');self.assertEqual(base64.b64decode(r['data']),b'helloworld');self.assertTrue(r['eof'])
        with self.assertRaises(ValueError):self.call('put','code/test.py',data='',offset=2)
    def test_chinese_identity_for_job(self):
        job={'id':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','userId':'demo-user-1','username':'测试同学','cards':1,'argv':['true'],'name':'check','minVramGiB':0}
        self.node.validate_job(job)
        self.assertTrue(self.node.gpuq_owner(job).startswith('portal-'))
        self.assertEqual(self.node.gpuq_owner(job),self.node.gpuq_owner({**job,'username':'另一同学'}))
        job['username']='测试$(id)'
        with self.assertRaises(ValueError):self.node.validate_job(job)
    def test_traversal_and_absolute_paths(self):
        for path in ['../x','/etc/passwd','foo/../../x','foo//x','foo/./x','foo\\x','']:
            with self.subTest(path=path),self.assertRaises(ValueError):self.call('get',path)
    def test_symlink_directory_and_file(self):
        outside=Path(self.temp.name)/'secret';outside.write_text('secret')
        (self.root/'link').symlink_to(outside);(self.root/'dir').symlink_to(outside.parent,target_is_directory=True)
        for path in ['link','dir/secret']:
            with self.subTest(path=path),self.assertRaises(OSError):self.call('get',path)
    def test_fifo_and_hardlinks(self):
        os.mkfifo(self.root/'fifo')
        with self.assertRaises(ValueError):self.call('get','fifo')
        (self.root/'one').write_text('one');os.link(self.root/'one',self.root/'two')
        with self.assertRaises(ValueError):self.call('get','two')
    def test_distinct_identities_and_invalid_identity(self):
        a=self.node.workspace('demo-user-1');b=self.node.workspace('demo-user-2');self.assertNotEqual(a,b)
        with self.assertRaises(ValueError):self.node.workspace('../jobs')
    def test_base64_validation_and_chunk_limit(self):
        with self.assertRaises(ValueError):self.call('put','bad',data='~garbage')
        with self.assertRaises(ValueError):self.call('put','large',data=base64.b64encode(b'x'*(1048576+1)).decode())
    def test_low_disk_does_not_truncate_existing_file(self):
        (self.root/'keep').write_text('keep me')
        with patch.object(self.node.os,'statvfs',return_value=SimpleNamespace(f_bavail=0,f_frsize=4096)):
            with self.assertRaises(ValueError):self.call('put','keep',data='eA==',truncate=True)
        self.assertEqual((self.root/'keep').read_text(),'keep me')
    def test_stale_terminal_socket_is_not_alive(self):
        folder=Path(self.temp.name);jid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        (folder/(jid+'.sock')).touch()
        self.assertFalse(self.node.terminal_alive(folder,jid))
        self.assertFalse(self.node.terminal_alive(folder,'../other'))
    def test_close_already_expired_terminal(self):
        with patch.object(self.node.subprocess,'run',side_effect=[SimpleNamespace(returncode=5),SimpleNamespace(returncode=3)]):
            self.node.stop_terminal('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
if __name__=='__main__':unittest.main()
