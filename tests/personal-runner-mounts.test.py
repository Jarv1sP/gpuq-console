"""Real mount planner and AST cleanup boundary; no container engine or GPU."""
import ast
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch

DEPLOY=Path(__file__).resolve().parents[1]/'deploy'
spec=importlib.util.spec_from_file_location('personal_mounts',DEPLOY/'personal-oci.py')
o=importlib.util.module_from_spec(spec);spec.loader.exec_module(o)


class Mounts(unittest.TestCase):
    def plan(self,personal):
        manager=Mock();manager.run.return_value='[]';manager.execute.return_value=0
        manager.owner='a'*64;manager.policy={'cdiSHA256':'a'*64};manager._mount_sources={}
        project={'code':Path('/private/code'),'environmentMode':'oci','meta':{'oci':{'image':'sha256:'+'a'*64}},
                 **({'readonly':False,'storageLayout':'personal-storage-v1'} if personal else {})}
        job={'id':'fixture','userId':'demo-user-8','project':'training','argv':['python','train.py']}
        with patch.object(o,'PersonalOCI',return_value=manager),patch.object(o,'module',return_value=SimpleNamespace(prepare=lambda *args:([],[]))),patch.object(Path,'exists',return_value=False):
            result=o.run_project({},job,project,False,[],1,
                {'home':2,'output':3},[(6,'/data-hdd/h-fixed'),(7,'/data-ssd/s-fixed')],
                personal_fds=[(4,'/data-hdd'),(5,'/data-ssd')] if personal else [])
        self.assertEqual(result,0)
        args=manager.execute.call_args
        with patch.object(o,'protected_file'),patch.object(o,'cdi_devices',return_value=[]),patch.object(Path,'read_bytes',return_value=b'{}'):
            flags=o.PersonalOCI.arguments(manager,job,project,False,[],args.args[4],args.kwargs['control'])
        return args,flags

    def test_personal_raw_parents_are_rw_before_readonly_version_children(self):
        args,flags=self.plan(True);mounts=args.args[4]
        self.assertIn((1,'/workspace',False),mounts)
        for parent,child in [((4,'/data-hdd',False),(6,'/data-hdd/h-fixed',True)),((5,'/data-ssd',False),(7,'/data-ssd/s-fixed',True))]:
            self.assertIn(parent,mounts);self.assertIn(child,mounts);self.assertLess(mounts.index(parent),mounts.index(child))
        self.assertIn('--env=GPUQ_OUTPUT_DIR=/workspace',flags)

    def test_legacy_training_workspace_stays_readonly_and_outputs_unchanged(self):
        args,flags=self.plan(False);self.assertIn((1,'/workspace',True),args.args[4])
        self.assertIn('--env=GPUQ_OUTPUT_DIR=/outputs',flags)

    def test_both_runners_keep_parent_locks_until_payload_stopped(self):
        for name in ['sandbox-runner.py','sandbox-runner-common-p0.py']:
            source=(DEPLOY/name).read_text();tree=ast.parse(source)
            main=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name==('run_job' if name=='sandbox-runner.py' else 'main'))
            spawn=next(node for node in ast.walk(main) if isinstance(node,ast.Try) and any('process=subprocess.Popen(args' in ast.get_source_segment(source,body).replace(' ','') for body in node.body))
            self.assertNotIn("getattr(personal_fds,'locks'",''.join(ast.get_source_segment(source,node) for node in spawn.finalbody))
            self.assertTrue(any("getattr(personal_fds,'locks'" in ast.get_source_segment(source,node) for node in spawn.handlers))
            wait=next(node for node in ast.walk(main) if isinstance(node,ast.Try) and any('process.wait()' in ast.get_source_segment(source,body) for body in node.body))
            cleanup=''.join(ast.get_source_segment(source,node) for node in wait.finalbody)
            self.assertLess(cleanup.index('process.wait()'),cleanup.index("getattr(personal_fds,'locks'"))
            self.assertLess(source.index('for descriptor,target in personal_fds:'),source.index('for descriptor,target in dataset_fds:'))


if __name__=='__main__':unittest.main()
