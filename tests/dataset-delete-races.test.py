"""Deterministic actual STAGING -> READY race; no positive safety mocks."""
import contextlib
import importlib.util
import os
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch

ROOT=Path(os.environ.get('DATASET_DELETE_CODE_ROOT',Path(__file__).resolve().parents[1]))
spec=importlib.util.spec_from_file_location('retention_race_cache',ROOT/'deploy/dataset-cache.py')
D=importlib.util.module_from_spec(spec);spec.loader.exec_module(D)
ADMIN=D.Principal('administrator',True)
OWNER=D.Principal('owner')

class LastCopyRaceTests(unittest.TestCase):
    def race(self,operation):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);source=base/'source';source.mkdir()
            (source/'data.txt').write_bytes(b'only complete bytes')
            cache=D.DatasetCache(base/'cache',sources={'source':source},reserve_bytes=0,lock_timeout=3)
            version=cache.register_source(ADMIN,'sample','source',['owner'])['version']
            transfer=cache.plan(OWNER,'sample',version)
            stage=cache._paths('sample',version)['.staging']/'data'
            (stage/'data.txt').write_bytes(b'only complete bytes')
            hashing=threading.Event();preflight=threading.Event();publish_now=threading.Event()
            failures=[];scan=D._scan;guard=cache._retention_guard
            def pause_scan(path):
                if Path(path)==stage:
                    hashing.set()
                    if not publish_now.wait(3):raise TimeoutError('publisher not released')
                return scan(path)
            @contextlib.contextmanager
            def preflight_guard(*args,**kwargs):
                with guard(*args,**kwargs) as protected:
                    preflight.set()
                    yield protected
            def publish():
                try:cache.publish(OWNER,'sample',version,transfer['token'])
                except BaseException as error:failures.append(('publish',error))
            def remove():
                try:
                    if operation=='evict':cache.evict(ADMIN,'sample',version)
                    else:cache.unregister(ADMIN,'sample',None if operation=='whole' else version)
                except BaseException as error:failures.append(('remove',error))
            with patch.object(D,'_scan',side_effect=pause_scan),patch.object(cache,'_retention_guard',side_effect=preflight_guard):
                publisher=threading.Thread(target=publish);publisher.start()
                self.assertTrue(hashing.wait(3),f'actual publisher must hold the version lock: {failures!r}')
                remover=threading.Thread(target=remove);remover.start()
                self.assertTrue(preflight.wait(3),'removal must see incomplete STAGING before lock')
                publish_now.set();publisher.join(5);remover.join(5)
                self.assertFalse(publisher.is_alive());self.assertFalse(remover.is_alive())
            self.assertEqual([error for name,error in failures if name=='publish'],[])
            rejected=[error for name,error in failures if name=='remove']
            self.assertEqual(len(rejected),1,'last-copy removal must reject after publication wins the lock')
            self.assertRegex(str(rejected[0]),'最后一份|重新核对')
            self.assertEqual((cache._paths('sample',version)['ready']/'data/data.txt').read_bytes(),b'only complete bytes')
            self.assertTrue(cache.verify(OWNER,'sample',version)['verified'])
            for root,_,files in os.walk(base):
                os.chmod(root,0o700)
                for name in files:Path(root,name).chmod(0o600)
    def test_staging_publication_wins_before_unregister_lock_preserves_last_ready(self):self.race('unregister')
    def test_staging_publication_wins_before_whole_unregister_lock_preserves_last_ready(self):self.race('whole')
    def test_staging_publication_wins_before_evict_lock_preserves_last_ready(self):self.race('evict')

if __name__=='__main__':unittest.main()
