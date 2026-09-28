"""Check deployment ownership decisions in a temporary tree, without root or SSH."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec=importlib.util.spec_from_file_location('init_vps_test',Path(__file__).resolve().parents[1]/'deploy/init-vps.py')
installer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class DeploymentPermissions(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name)/'deployment';self.base.mkdir(mode=0o700)
        (self.base/'inventory.json').write_text(json.dumps({'nodes':[]}))
        (self.base/'inventory.json').chmod(0o600)

    def test_normalizes_base_and_inventory_without_recursing_into_data(self):
        data=self.base/'data';data.mkdir();db=data/'portal.sqlite';db.write_text('existing database');db.chmod(0o640)
        key=data/'portal.sqlite.invite-key';key.write_text('existing key');key.chmod(0o600)
        before=(db.read_bytes(),key.read_bytes(),stat.S_IMODE(db.stat().st_mode))
        with patch.object(installer.os,'chown') as chown:
            installer.prepare_layout(self.base)
        self.assertEqual(stat.S_IMODE(self.base.stat().st_mode),0o755)
        self.assertEqual(stat.S_IMODE((self.base/'inventory.json').stat().st_mode),0o600)
        calls={Path(c.args[0]):c.args[1:] for c in chown.call_args_list}
        self.assertEqual(calls[self.base],(0,0));self.assertEqual(calls[self.base/'inventory.json'],(0,0))
        self.assertEqual(calls[data],(1000,1000));self.assertEqual(calls[self.base/'status'],(0,1000))
        self.assertNotIn(db,calls);self.assertNotIn(key,calls)
        self.assertEqual((db.read_bytes(),key.read_bytes(),stat.S_IMODE(db.stat().st_mode)),before)
        self.assertTrue(all(c.kwargs.get('follow_symlinks') is False for c in chown.call_args_list))

    def test_managed_file_ownership_and_permissions_are_explicit(self):
        with patch.object(installer.os,'chown') as chown:
            for name,mode in [('id_ed25519',0o600),('id_ed25519.pub',0o644),('known_hosts',0o600),('collect-status.py',0o700)]:
                path=self.base/name;path.write_text('preserve content');path.chmod(0o777)
                installer.secure_file(path,mode)
                self.assertEqual(path.read_text(),'preserve content')
                self.assertEqual(stat.S_IMODE(path.stat().st_mode),mode)
                chown.assert_called_with(path,0,0,follow_symlinks=False)

    def test_inventory_symlink_is_not_followed(self):
        inventory=self.base/'inventory.json';inventory.unlink()
        secret=Path(self.temp.name)/'untouched';secret.write_text('outside');secret.chmod(0o640)
        inventory.symlink_to(secret)
        with patch.object(installer.os,'chown') as chown,self.assertRaisesRegex(ValueError,'regular, non-linked'):
            installer.prepare_layout(self.base)
        self.assertEqual(secret.read_text(),'outside');self.assertEqual(stat.S_IMODE(secret.stat().st_mode),0o640)
        self.assertNotIn(secret,[c.args[0] for c in chown.call_args_list])

    def test_data_directory_symlink_is_rejected(self):
        outside=Path(self.temp.name)/'outside';outside.mkdir();(self.base/'data').symlink_to(outside,target_is_directory=True)
        with patch.object(installer.os,'chown'),self.assertRaisesRegex(ValueError,'real management directory'):
            installer.prepare_layout(self.base)

    def test_key_symlink_and_hardlink_are_rejected(self):
        original=self.base/'original';original.write_text('private');original.chmod(0o600)
        for kind in ('symlink','hardlink'):
            link=self.base/kind
            if kind=='symlink':link.symlink_to(original)
            else:os.link(original,link)
            with self.subTest(kind=kind),patch.object(installer.os,'chown') as chown,self.assertRaisesRegex(ValueError,'regular, non-linked'):
                installer.secure_file(link)
            chown.assert_not_called();link.unlink()

    def test_missing_optional_file_is_not_created(self):
        path=self.base/'absent'
        self.assertFalse(installer.check_file(path,required=False));self.assertFalse(path.exists())


class RenameCompatibility(unittest.TestCase):
    def root_helper(self):
        # Extract the pure selector without starting the module's real PTY code.
        path=Path(__file__).resolve().parents[1]/'deploy/terminal-helper.py'
        tree=ast.parse(path.read_text())
        nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='root_shell' or isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='ROOT_SHELLS' for t in n.targets)]
        namespace={'Path':Path,'stat':stat}
        exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),namespace)
        return namespace['root_shell'],namespace['ROOT_SHELLS']

    def test_root_helper_prefers_new_fixed_path(self):
        selector,paths=self.root_helper()
        self.assertEqual(paths,('/usr/local/libexec/gpuq-console-root-shell','/usr/local/libexec/amax-console-root-shell'))
        with patch.object(Path,'lstat',return_value=SimpleNamespace(st_mode=stat.S_IFREG|0o755,st_uid=0)):
            self.assertEqual(selector(),paths[0])

    def test_root_helper_falls_back_to_old_fixed_path_only_if_new_absent(self):
        selector,paths=self.root_helper()
        with patch.object(Path,'lstat',side_effect=[FileNotFoundError(),SimpleNamespace(st_mode=stat.S_IFREG|0o755,st_uid=0)]):
            self.assertEqual(selector(),paths[1])
        with patch.object(Path,'lstat',side_effect=FileNotFoundError()),self.assertRaisesRegex(ValueError,'not installed'):
            selector()

    def test_root_helper_rejects_untrusted_files_without_unsafe_fallback(self):
        selector,_=self.root_helper()
        for mode,uid in [(stat.S_IFLNK|0o777,0),(stat.S_IFREG|0o755,1000),(stat.S_IFREG|0o775,0)]:
            with self.subTest(mode=mode,uid=uid),patch.object(Path,'lstat',return_value=SimpleNamespace(st_mode=mode,st_uid=uid)) as inspect,self.assertRaisesRegex(ValueError,'Unsafe'):
                selector()
            self.assertEqual(inspect.call_count,1)

    def test_both_job_id_environment_names_are_equal(self):
        path=Path(__file__).resolve().parents[1]/'deploy/sandbox-runner.py'
        tree=ast.parse(path.read_text())
        mappings=[node for node in ast.walk(tree) if isinstance(node,ast.Dict) and any(isinstance(key,ast.Constant) and key.value=='GPUQ_JOB_ID' for key in node.keys)]
        self.assertEqual(len(mappings),1)
        values=eval(compile(ast.Expression(body=mappings[0]),str(path),'eval'),{'spec':{'username':'member'},'uuids':['GPU-test'],'jid':'job-test'})
        self.assertEqual(values['GPUQ_JOB_ID'],'job-test');self.assertEqual(values['AMAX_JOB_ID'],'job-test')


if __name__=='__main__':unittest.main()
