"""Configure only disposable runtime files; systemd calls are captured."""
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

DEPLOY=Path(__file__).resolve().parents[1]/'deploy';sys.path.insert(0,str(DEPLOY));import node_runtime
spec=importlib.util.spec_from_file_location('configure_transfers_tests',DEPLOY/'configure-transfers.py');C=importlib.util.module_from_spec(spec);spec.loader.exec_module(C)
class Configuration(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name);self.dest=self.base/'runtime';self.dest.mkdir(mode=0o700);self.home=self.base/'home';self.home.mkdir();self.calls=[]
        for name,source in node_runtime.runtime_plan('common-p0'):shutil.copy2(DEPLOY/source,self.dest/name)
        self.original={'root':str(self.base/'state'),'hostRoot':False,'database':'preserve.db','transferPeers':{'old':{'address':'192.168.77.4','port':18443,'certificateSha256':'a'*64}}}
        self.path=self.dest/'node-config.json';self.path.write_text(json.dumps(self.original));self.path.chmod(0o600)
        self.settings=self.base/'peers.json';self.settings.write_text(json.dumps({'transferPeers':{'gpu-1':{'address':'192.168.77.3','port':18443,'certificateSha256':'b'*64}}}));self.settings.chmod(0o600)
        self.patches=[patch.object(C.Path,'home',return_value=self.home),patch.object(C.subprocess,'run',side_effect=lambda argv,**kw:self.calls.append(argv) or SimpleNamespace(returncode=0,stdout=''))]
        for p in self.patches:p.start()
    def tearDown(self):
        for p in self.patches:p.stop()
        self.temp.cleanup()
    def args(self,**kw):return SimpleNamespace(program_dir=self.dest,peer_config=self.settings,apply=kw.get('apply',False),enable_peer=kw.get('enable_peer',False))
    def test_dry_run_has_no_writes_and_apply_preserves_gpuq_without_enabling_peer(self):
        before=self.path.read_bytes();result=C.configure(self.args());self.assertTrue(result['dryRun']);self.assertEqual(self.calls,[]);self.assertEqual(self.path.read_bytes(),before)
        result=C.configure(self.args(apply=True));current=json.loads(self.path.read_text());self.assertFalse(current['hostRoot']);self.assertEqual(current['database'],'preserve.db');self.assertEqual(current['root'],self.original['root']);self.assertEqual(Path(result['backup']).read_bytes(),before)
        self.assertEqual(self.calls,[['/usr/bin/systemctl','--user','daemon-reload']]);self.assertTrue((self.home/'.config/systemd/user/gpuq-transfer-peer.service').is_file())
    def test_missing_runtime_or_privileged_fields_rejected_before_any_config_write(self):
        before=self.path.read_bytes();(self.dest/'transfer-peer.py').unlink()
        with self.assertRaises(FileNotFoundError):C.configure(self.args(apply=True))
        self.assertEqual(self.path.read_bytes(),before);self.assertEqual(self.calls,[])
        self.settings.write_text(json.dumps({'hostRoot':True}))
        with self.assertRaisesRegex(ValueError,'Only'):C.configure(self.args(apply=True))
    def test_public_peer_addresses_and_implicit_enable_rejected(self):
        self.settings.write_text(json.dumps({'transferPeers':{'gpu-1':{'address':'8.8.8.8','port':18443,'certificateSha256':'a'*64}}}))
        with self.assertRaisesRegex(ValueError,'LAN'):C.configure(self.args())
        self.settings.write_text(json.dumps({'transferPeers':{}}))
        with self.assertRaisesRegex(ValueError,'listener'):C.configure(self.args(enable_peer=True,apply=True))
        self.assertEqual(self.calls,[])
if __name__=='__main__':unittest.main()
