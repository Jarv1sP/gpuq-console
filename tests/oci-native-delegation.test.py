"""New-unit delegation recipe is opt-in and coordinator-selected, no services."""
import ast,importlib.util,json,uuid
from pathlib import Path
import subprocess,sys,unittest
from unittest.mock import Mock,patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'gpuq'))
from gpuq.backends import UserSystemdBackend
from gpuq.backends import UnitNotFoundError
from gpuq.constants import AttemptState
from gpuq.cli import parse_env, captured_environment
from gpuq.submission import RESERVED_ENV
from gpuq.util import validate_env
from types import SimpleNamespace
class NativeDelegation(unittest.TestCase):
 def setUp(self):
  self.run=Mock(return_value=subprocess.CompletedProcess([],0,'',''));self.backend=UserSystemdBackend(runner=self.run)
  self.args={'unit_name':'gpuq-test','description_token':'owned-test','argv':['/usr/bin/python3','-c','pass'],'cwd':'/tmp','env':{},'log_path':'/tmp/own-log'}
  p=patch.object(self.backend,'status',return_value='verified');p.start();self.addCleanup(p.stop)
 def test_default_and_false_leave_recipe_unchanged(self):
  for extra in ({},{'delegate':False}):
   self.backend.start(**self.args,**extra);self.assertNotIn('--property=Delegate=yes',self.run.call_args.args[0])
 def test_true_only_adds_property_before_payload(self):
  self.backend.start(**self.args,delegate=True);argv=self.run.call_args.args[0]
  self.assertEqual(argv.count('--property=Delegate=yes'),1);self.assertLess(argv.index('--property=Delegate=yes'),argv.index('--'))
  self.assertIn('--property=KillMode=control-group',argv);self.assertIn('--property=Restart=no',argv)
 def test_nonboolean_rejected_without_action(self):
  for value in ('yes',1,None):self.assertRaises(ValueError,self.backend.start,**self.args,delegate=value)
  self.run.assert_not_called()
 def test_coordinator_uses_exact_saved_payload_marker(self):
  tree=ast.parse((ROOT/'gpuq/gpuq/coordinator.py').read_text())
  call=next(v for v in ast.walk(tree) if isinstance(v,ast.Call) and isinstance(v.func,ast.Attribute) and v.func.attr=='start' and any(k.arg is None for k in v.keywords))
  expression=next(k.value for k in call.keywords if k.arg is None);code=compile(ast.Expression(expression),'<saved-launch-marker>','eval')
  for env,wanted in (({},{}),({'GPUQ_CONSOLE_OCI':'1'},{'delegate':True}),({'GPUQ_CONSOLE_OCI':'true'},{}),({'GPUQ_CONSOLE_OCI':1},{}),({'GPUQ_CONSOLE_OCI':'0'},{})):
   self.assertEqual(eval(code,{'payload':{'env':env}}),wanted)
 def test_only_exact_console_marker_can_be_explicitly_submitted(self):
  wanted={'GPUQ_CONSOLE_OCI':'1'}
  self.assertEqual(parse_env(['GPUQ_CONSOLE_OCI=1']),wanted)
  self.assertEqual(validate_env(wanted,RESERVED_ENV),wanted)
  for env in ({'GPUQ_CONSOLE_OCI':'0'},{'GPUQ_CONSOLE_OCI':'true'},{'GPUQ_CONSOLE_OCI':1},{'GPUQ_ASSIGNED_GPU_UUIDS':'GPU-0'},{'GPUQ_OTHER':'1'}):
   self.assertRaises(ValueError,validate_env,env,RESERVED_ENV)
   self.assertRaises(ValueError,parse_env,[k+'='+str(v) for k,v in env.items()]) if env!={'GPUQ_CONSOLE_OCI':1} else None
 def test_marker_is_never_captured_from_host_environment(self):
  with patch.dict('os.environ',{'GPUQ_CONSOLE_OCI':'1'},clear=True):self.assertNotIn('GPUQ_CONSOLE_OCI',captured_environment())

class DurableLaunch(unittest.TestCase):
 def setUp(self):
  s=importlib.util.spec_from_file_location('priority_fixture',ROOT/'tests/gpuq-priority.test.py');self.fixture=importlib.util.module_from_spec(s);s.loader.exec_module(self.fixture)
  self.fixture.SchedulerPriorityTests.setUp(self)
 snapshot=lambda self,**kw:self.fixture.SchedulerPriorityTests.snapshot(self,**kw)
 submit=lambda self,**kw:self.fixture.SchedulerPriorityTests.submit(self,**kw)
 def start(self,env):
  job=self.submit(env=env);aid='A'+uuid.uuid4().hex;control,log=self.coordinator._create_attempt_paths(job['id'],aid)
  self.store.create_attempt(job['id'],attempt_id=aid,state='STARTING',gpu_uuids=['GPU-0'],gpu_indices=[0],unit_name='gpuq-'+aid.lower(),unit_token='attempt:'+aid,boot_id='test-boot',control_dir=str(control),log_path=str(log))
  self.store.update_job(job['id'],state='STARTING');self.store.acquire_leases(job['id'],aid,{'GPU-0':0})
  self.systemd.status.side_effect=UnitNotFoundError('not found');self.systemd.start.return_value=SimpleNamespace(main_pid=0,invocation_id='a'*32,unit_name='gpuq-'+aid.lower()+'.service')
  action={'attempt_id':aid,'job_id':job['id'],'payload':{'unit_name':'gpuq-'+aid.lower(),'unit_token':'attempt:'+aid,'gpu_uuids':['GPU-0'],'gpu_indices':[0],'argv':job['argv'],'cwd':str(self.root),'env':env,'log_path':str(log)}}
  with patch.object(self.coordinator,'_fresh_devices_for_start',return_value={}):self.coordinator._execute_start(action)
  self.assertEqual(json.loads((control/'launch.json').read_text())['env'],env)
  self.assertEqual(self.store.get_attempt(aid)['state'],AttemptState.RUNNING.value)
  return self.systemd.start.call_args.kwargs
 def test_saved_marker_reaches_native_new_unit(self):self.assertIs(self.start({'GPUQ_CONSOLE_OCI':'1'})['delegate'],True)
 def test_ordinary_saved_environment_keeps_legacy_recipe(self):self.assertNotIn('delegate',self.start({}))
 def test_nonexact_marker_is_rejected_before_launch(self):
  self.assertRaises(ValueError,self.start,{'GPUQ_CONSOLE_OCI':'0'});self.systemd.start.assert_not_called()
if __name__=='__main__':unittest.main()
