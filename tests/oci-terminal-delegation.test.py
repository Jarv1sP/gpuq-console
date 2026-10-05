"""Only trusted new OCI project terminals delegate; no live services."""
import ast,importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch
SOURCE=Path(__file__).resolve().parents[1]/'deploy/node-executor.py'
class Delegation(unittest.TestCase):
 def setUp(self):
  tree=ast.parse(SOURCE.read_text());functions=[v for v in tree.body if isinstance(v,ast.FunctionDef) and v.name in ('personal_oci_project','terminal_oci_properties','oci_submission_arguments')]
  self.store=SimpleNamespace(environment_mode=Mock(return_value='oci'));self.policy=Mock()
  self.env={'projects':lambda:SimpleNamespace(store=self.store),'HERE':Path('/fixed/service'),'CONFIG':{'personalOci':{'enabled':True}},'importlib':importlib}
  exec(compile(ast.Module(body=functions,type_ignores=[]),str(SOURCE),'exec'),self.env);self.fn=self.env['terminal_oci_properties']
  loader=Mock();loader.exec_module=Mock();module=SimpleNamespace(policy=self.policy)
  self.patches=[patch.object(importlib.util,'spec_from_file_location',return_value=SimpleNamespace(loader=loader)),patch.object(importlib.util,'module_from_spec',return_value=module)]
  for p in self.patches:p.start();self.addCleanup(p.stop)
  self.args={'userId':'demo-user-3','project':'example','hostAdmin':False}
 def test_owned_oci_only(self):
  self.assertEqual(self.fn(self.args),['--property=Delegate=yes']);self.store.environment_mode.assert_called_once_with('demo-user-3','example');self.policy.assert_called_once_with(self.env['CONFIG'],'demo-user-3')
 def test_no_project_root_and_data_do_not_delegate(self):
  for a in ({'userId':'demo-user-3'},{**self.args,'hostAdmin':True},{**self.args,'dataWorkspace':True}):self.assertEqual(self.fn(a),[])
  self.store.environment_mode.assert_not_called();self.policy.assert_not_called()
 def test_shared_isolated_and_client_mode_ignored(self):
  for mode in ('shared','isolated'):
   self.store.environment_mode.return_value=mode;self.assertEqual(self.fn({**self.args,'environmentMode':'oci','Delegate':True}),[])
  self.policy.assert_not_called()
 def test_wrong_owner_and_missing_project_fail_closed(self):
  self.store.environment_mode.side_effect=ValueError('not owned');self.assertRaises(ValueError,self.fn,self.args);self.policy.assert_not_called()
 def test_disabled_or_noncohort_policy_fail_closed(self):
  self.policy.side_effect=ValueError('disabled or wrong cohort');self.assertRaises(ValueError,self.fn,self.args)
 def test_training_marker_uses_same_authenticated_guard(self):
  fn=self.env['oci_submission_arguments'];self.assertEqual(fn(self.args),['--env','GPUQ_CONSOLE_OCI=1'])
  self.store.environment_mode.return_value='shared';self.assertEqual(fn({**self.args,'env':{'GPUQ_CONSOLE_OCI':'1'}}),[])
  self.store.environment_mode.return_value='oci';self.policy.side_effect=ValueError('noncohort');self.assertRaises(ValueError,fn,self.args)
 def test_only_new_branch_precedes_spec_and_start(self):
  text=SOURCE.read_text();body=text[text.index('def terminal_op('):text.index('\ndef ',text.index('def terminal_op(')+1)]
  self.assertEqual(body.count('oci_properties=terminal_oci_properties(args)'),1)
  self.assertLess(body.index("if mode=='new' and not (folder/(jid+'.json')).exists():"),body.index('oci_properties=terminal_oci_properties(args)'))
  self.assertLess(body.index('oci_properties=terminal_oci_properties(args)'),body.index('with open(folder/(jid+\'.json\'),\'x\')'))
  self.assertLess(body.index('command+=oci_properties'),body.index("run(command+['/usr/bin/python3'"))
if __name__=='__main__':unittest.main()
