"""Actual private Handler / executor dispatch; isolated AST and fake transport.

No inventory, node config, credential, external socket, service or GPU is read.
The real new helper dispatcher is used for strict fields, with action leaves
replaced by spies; no dataset tree mutation is performed.
"""
import ast
import importlib.util
import io
import json
from pathlib import Path
import socketserver
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

ROOT=Path(__file__).resolve().parents[1]
KEY='12345678-1234-4234-8234-123456789012'
VERSION='a'*64
ACTIONS=('capabilities','prepare','release','status','cancel')

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


class CacheBridgeTests(unittest.TestCase):
    def handler(self,operation,machine='fixture-node',args=None,failure=None):
        tree=ast.parse((ROOT/'deploy/execution-worker.py').read_text())
        base=next(value for value in tree.body if isinstance(value,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='INTERNAL_STORAGE' for target in value.targets))
        extension=next(value for value in tree.body if isinstance(value,ast.AugAssign) and isinstance(value.target,ast.Name)
                       and value.target.id=='INTERNAL_STORAGE' and 'storage.cache-action.' in ast.unparse(value.value))
        definitions=[next(value for value in tree.body if isinstance(value,ast.ClassDef) and value.name=='NodeTransportError'),
                     next(value for value in tree.body if isinstance(value,ast.FunctionDef) and value.name=='ssh_transport_failure'),
                     next(value for value in tree.body if isinstance(value,ast.ClassDef) and value.name=='Handler')]
        call=Mock(side_effect=failure,return_value=SimpleNamespace(returncode=0,stdout=json.dumps({'ok':True,'result':{'key':KEY,'state':'UNKNOWN'}})))
        namespace=dict(socketserver=socketserver,json=json,HOSTS={'fixture-node':{'fixture':True}},
                       SSH_CONNECTIONS=SimpleNamespace(call=call),TERMINAL_STREAM_HOSTS=set())
        exec(compile(ast.Module(body=[base,extension,*definitions],type_ignores=[]),'<actual private cache Handler>','exec'),namespace)
        handler=object.__new__(namespace['Handler']);handler.request=Mock()
        payload={'machine':machine,'operation':operation,'args':args if args is not None else {}}
        handler.rfile=io.BytesIO((json.dumps(payload)+'\n').encode());handler.wfile=io.BytesIO()
        handler.handle()
        return json.loads(handler.wfile.getvalue()),call,namespace['INTERNAL_STORAGE']

    def test_exact_five_literals_cross_real_handler_with_unchanged_authenticated_identity(self):
        for action in ACTIONS:
            args={'userId':'fixture-owner','hostAdmin':False}
            args.update({'key':KEY} if action in ('status','cancel') else {'dataset':'sample','version':VERSION,**({'key':KEY} if action in ('prepare','release') else {})})
            with self.subTest(action=action):
                operation='storage.cache-action.'+action
                result,call,allowed=self.handler(operation,args=args)
                self.assertTrue(result['ok'],result)
                call.assert_called_once_with({'fixture':True},{'operation':operation,'args':args})
                self.assertEqual({value.removeprefix('storage.cache-action.') for value in allowed if value.startswith('storage.cache-action.')},set(ACTIONS))

    def test_neighbor_namespace_unknown_operations_and_machine_have_zero_dispatch(self):
        cases=[('storage.cache-action.'+action,'fixture-node') for action in ('force','evict','collect','release.extra','*','constructor')]
        cases += [('storage.cache-actions.release','fixture-node'),('datasets.cache.release','fixture-node'),('storage.cache-action.release','unknown-node')]
        for operation,machine in cases:
            with self.subTest(operation=operation,machine=machine):
                result,call,_=self.handler(operation,machine)
                self.assertFalse(result['ok']);self.assertEqual(result['error'],'Invalid operation');call.assert_not_called()

    def test_transport_failure_is_unknown_and_not_replayed(self):
        for action in ('prepare','release','cancel'):
            with self.subTest(action=action):
                result,call,_=self.handler('storage.cache-action.'+action,failure=subprocess.TimeoutExpired('isolated-cache-rpc',1))
                self.assertFalse(result['ok']);call.assert_called_once()


class CacheExecutorTests(unittest.TestCase):
    def setUp(self):
        self.D=load('cache_bridge_dataset_module','deploy/dataset-cache.py')
        self.C=load('cache_bridge_actions_module','deploy/dataset-cache-actions.py')
        self.actions=object.__new__(self.C.CacheActionNode)
        for name in ('capabilities','start','status','cancel'):
            setattr(self.actions,name,Mock(return_value={'state':'FIXTURE'}))
        tree=ast.parse((ROOT/'deploy/node-executor.py').read_text())
        definitions=[next(value for value in tree.body if isinstance(value,ast.FunctionDef) and value.name==name)
                     for name in ('dataset_actor','dataset_cache_action_operation','process')]
        self.workspace=Mock();self.root_guard=Mock();self.cache=Mock(return_value=(self.D,None));self.get_actions=Mock(return_value=self.actions)
        self.namespace=dict(workspace=self.workspace,platform_root_check=self.root_guard,dataset_cache=self.cache,dataset_cache_actions=self.get_actions)
        exec(compile(ast.Module(body=definitions,type_ignores=[]),'<actual cache executor dispatch>','exec'),self.namespace)

    def test_actual_process_dispatch_constructs_member_principal_and_strips_trusted_context(self):
        for action in ACTIONS:
            with self.subTest(action=action):
                self.setUp()
                args={'userId':'fixture-owner','hostAdmin':False}
                args.update({'key':KEY} if action in ('status','cancel') else {'dataset':'sample','version':VERSION,**({'key':KEY} if action in ('prepare','release') else {})})
                original=json.loads(json.dumps(args))
                self.assertEqual(self.namespace['process']('storage.cache-action.'+action,args),{'state':'FIXTURE'})
                self.root_guard.assert_called_once();self.workspace.assert_called_once_with('fixture-owner')
                leaf=self.actions.start if action in ('prepare','release') else getattr(self.actions,action)
                leaf.assert_called_once();actor=leaf.call_args.args[0]
                self.assertIsInstance(actor,self.D.Principal);self.assertEqual(actor.user_id,'fixture-owner');self.assertFalse(actor.is_admin)
                if action in ('prepare','release'):
                    self.assertEqual(leaf.call_args.args[1],action)
                self.assertEqual(args,original)
                self.assertNotIn('userId',leaf.call_args.kwargs);self.assertNotIn('hostAdmin',leaf.call_args.kwargs)

    def test_forged_root_or_missing_identity_and_neighbor_operations_never_call_cache_dispatch(self):
        for args in ({'userId':'fixture-owner','hostAdmin':True},{'userId':'fixture-owner','hostAdmin':1},
                     {'userId':'fixture-owner'},{'hostAdmin':False}):
            with self.subTest(args=args):
                self.setUp()
                with self.assertRaises((ValueError,KeyError)):
                    self.namespace['process']('storage.cache-action.status',args)
                self.get_actions.assert_not_called()
        for operation in ('storage.cache-action.force','storage.cache-action.release.extra','storage.cache-actions.release','datasets.cache.release'):
            with self.subTest(operation=operation):
                self.setUp()
                with self.assertRaises(ValueError):self.namespace['process'](operation,{'userId':'fixture-owner','hostAdmin':False,'key':KEY})
                self.get_actions.assert_not_called();self.cache.assert_not_called()

    def test_real_helper_dispatch_rejects_all_client_identity_path_and_source_overrides(self):
        for field,value in {'owner':'other','role':'admin','actor':{},'path':'/unsafe','source':'node','disk':'hdd','proof':{},'op':'release'}.items():
            with self.subTest(field=field):
                self.setUp()
                args=dict(userId='fixture-owner',hostAdmin=False,dataset='sample',version=VERSION,key=KEY,**{field:value})
                with self.assertRaises(ValueError):self.namespace['process']('storage.cache-action.release',args)
                self.actions.start.assert_not_called();self.actions.capabilities.assert_not_called()


if __name__=='__main__':unittest.main()
