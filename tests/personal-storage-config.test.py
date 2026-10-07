"""Dry run and two-target initialization; real private temp directories only."""
import importlib.util
from pathlib import Path
import stat
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parents[1]/'deploy'
definition=importlib.util.spec_from_file_location('personal_configuration',HERE/'configure-personal-storage.py')
c=importlib.util.module_from_spec(definition);definition.loader.exec_module(c)


class Configuration(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name).resolve()
        self.hdd=self.base/'hdd';self.ssd=self.base/'ssd'
        self.original=c.load;self.layout=c.load()
        def mount(path,mounts):
            tier='hdd' if Path(path)==self.hdd else 'ssd'
            return {'target':str(self.base),'source':'/dev/test-'+tier,'device':'1:2'}
        self.layout.data_mount=mount;self.layout.read_mounts=lambda:[]
        self.layout.trusted_parents=lambda *args:None
        self.loader=patch.object(c,'load',return_value=self.layout);self.loader.start();self.addCleanup(self.loader.stop)
        self.uid=12345;original=Path.stat
        def status(path,*args,**kwargs):
            if str(path).startswith('/dev/test-'):return SimpleNamespace(st_mode=stat.S_IFBLK|0o600)
            return original(path,*args,**kwargs)
        probe=patch.object(Path,'stat',status);probe.start();self.addCleanup(probe.stop)
        self.calls=[]
        def output(command,**kwargs):
            self.calls.append(command)
            tier=command[-1].rsplit('-',1)[-1]
            return ('1' if tier=='hdd' else '0') if 'lsblk' in command[0] else ('11111111-1111-1111-1111-111111111111' if tier=='hdd' else '22222222-2222-2222-2222-222222222222')
        process=patch.object(c.subprocess,'check_output',side_effect=output);process.start();self.addCleanup(process.stop)

    def test_dry_run_never_creates_roots_and_defaults_disabled(self):
        with patch.object(c.os,'chown',side_effect=AssertionError):result=c.plan(str(self.hdd),str(self.ssd),self.uid,0,0)
        self.assertTrue(result['dryRun']);self.assertFalse(result['readyToConfigure']);self.assertFalse(result['personalStorage']['enabled'])
        self.assertFalse(self.hdd.exists());self.assertFalse(self.ssd.exists())

    def test_invalid_second_tier_makes_zero_changes(self):
        with patch.object(c.os,'geteuid',return_value=0),patch.object(c.subprocess,'check_output',return_value='1'):
            with self.assertRaisesRegex(ValueError,'media type'):c.plan(str(self.hdd),str(self.ssd),self.uid,0,0,initialize=True)
        self.assertFalse(self.hdd.exists());self.assertFalse(self.ssd.exists())

    def test_initialize_creates_only_two_missing_roots_after_preflight(self):
        original=Path.lstat
        def inspect(path,*args,**kwargs):
            value=original(path,*args,**kwargs)
            if path in (self.hdd,self.ssd):return SimpleNamespace(st_uid=self.uid,st_mode=value.st_mode,st_ino=value.st_ino)
            return value
        with patch.object(c.os,'geteuid',return_value=0),patch.object(c.os,'chown') as chown,patch.object(Path,'lstat',inspect):
            result=c.plan(str(self.hdd),str(self.ssd),self.uid,0,0,initialize=True)
        self.assertFalse(result['dryRun']);self.assertTrue(result['readyToConfigure']);self.assertFalse(result['personalStorage']['enabled'])
        self.assertEqual(chown.call_count,2);self.assertEqual(sorted(p.name for p in self.base.iterdir()),['hdd','ssd'])
        self.assertTrue(all(stat.S_IMODE(p.stat().st_mode)==0o700 for p in (self.hdd,self.ssd)))

    def test_missing_mount_or_nonroot_initialize_does_not_fallback(self):
        with patch.object(c.os,'geteuid',return_value=1000):
            with self.assertRaisesRegex(ValueError,'requires root'):c.plan(str(self.hdd),str(self.ssd),self.uid,0,0,initialize=True)
        self.layout.data_mount=lambda *args: (_ for _ in ()).throw(ValueError('No independent data mount'))
        with self.assertRaises(ValueError):c.plan(str(self.hdd),str(self.ssd),self.uid,0,0)
        self.assertFalse(self.hdd.exists());self.assertFalse(self.ssd.exists())


if __name__=='__main__':unittest.main()
