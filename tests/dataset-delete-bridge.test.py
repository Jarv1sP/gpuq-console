"""The real bridge Handler must forward exactly the private deletion reads."""
import ast
import io
import json
from pathlib import Path
import socketserver
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

ROOT=Path(__file__).resolve().parents[1]

class DeletionBridge(unittest.TestCase):
    def handler(self,operation,machine='fixture-node',args=None):
        tree=ast.parse((ROOT/'deploy/execution-worker.py').read_text())
        base=next(n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='INTERNAL_STORAGE' for t in n.targets))
        extension=next(n for n in tree.body if isinstance(n,ast.AugAssign) and isinstance(n.target,ast.Name)
            and n.target.id=='INTERNAL_STORAGE' and 'storage.dataset-delete.' in ast.unparse(n.value))
        cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Handler')
        call=Mock(return_value=SimpleNamespace(returncode=0,stdout=json.dumps({'ok':True,'result':{'state':'REGISTERED'}})))
        namespace=dict(socketserver=socketserver,json=json,HOSTS={'fixture-node':{'fixture':True}},
            SSH_CONNECTIONS=SimpleNamespace(call=call),TERMINAL_STREAM_HOSTS=set())
        exec(compile(ast.Module(body=[base,extension,cls],type_ignores=[]),'<real deletion bridge boundary>','exec'),namespace)
        handler=object.__new__(namespace['Handler']);handler.request=Mock()
        payload=dict(machine=machine,operation=operation,args=args or {})
        handler.rfile=io.BytesIO((json.dumps(payload)+'\n').encode());handler.wfile=io.BytesIO()
        handler.handle()
        return json.loads(handler.wfile.getvalue()),call,namespace['INTERNAL_STORAGE']

    def test_SF7_new_registration_proof_reaches_real_private_bridge_without_changing_identity_or_reference(self):
        args=dict(userId='fixture-user',hostAdmin=False,dataset='sample',version='a'*64)
        reply,call,operations=self.handler('storage.dataset-delete.registration',args=args)
        self.assertTrue(reply['ok'],reply)
        call.assert_called_once_with({'fixture':True},{'operation':'storage.dataset-delete.registration','args':args})
        deletion={op.removeprefix('storage.dataset-delete.') for op in operations if op.startswith('storage.dataset-delete.')}
        self.assertEqual(deletion,{'capabilities','locations','registration','registration-discard','plan','fence','isolate','status','restore','release-absence','cancel','commit'})

    def test_NBB_admin_discard_is_forwarded_by_actual_bridge_without_path_or_identity_changes(self):
        args=dict(userId='fixture-admin',hostAdmin=True,operationId='fixed-operation',requestKey='fixed-attempt')
        reply,call,_=self.handler('storage.dataset-delete.registration-discard',args=args)
        self.assertTrue(reply['ok'],reply)
        call.assert_called_once_with({'fixture':True},{'operation':'storage.dataset-delete.registration-discard','args':args})

    def test_private_bridge_unknown_machine_and_unlisted_override_have_zero_node_calls(self):
        for op,machine in (('storage.dataset-delete.registration','unknown'),('storage.dataset-delete.unfence','fixture-node'),
                           ('storage.dataset-delete.force','fixture-node'),('storage.dataset-delete.collect','fixture-node')):
            with self.subTest(op=op,machine=machine):
                reply,call,_=self.handler(op,machine)
                self.assertFalse(reply['ok']);self.assertRegex(reply['error'],'Invalid operation');call.assert_not_called()

if __name__=='__main__':unittest.main()
