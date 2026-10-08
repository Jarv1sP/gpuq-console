"""Private source context routing only; no executor configuration or nodes."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


class SourcePolicyRoute(unittest.TestCase):
    def setUp(self):
        path=Path(__file__).resolve().parents[1]/'deploy'/'node-executor.py'
        tree=ast.parse(path.read_text())
        function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='storage_archive_operation')
        self.adapter=SimpleNamespace(certify=Mock(return_value={'state':'READY'}),retire=Mock(return_value={'state':'REVOKED'}),outbox_list=Mock(return_value={'events':[]}))
        self.factory=Mock(return_value=self.adapter)
        namespace={'storage_archive':self.factory}
        exec(compile(ast.Module(body=[function],type_ignores=[]),str(path),'exec'),namespace)
        self.route=namespace['storage_archive_operation']
        self.policy={'enabled':True,'machine':'warehouse-2','authority':'hdd-2'}

    def test_only_target_operations_accept_private_source_context(self):
        request={'opId':'fixed','sourcePolicy':self.policy}
        self.assertEqual(self.route('storage.archive.certify',request),{'state':'READY'})
        self.factory.assert_called_with(self.policy)
        self.adapter.certify.assert_called_once_with({'opId':'fixed'})
        self.assertIn('sourcePolicy',request)
        self.route('storage.archive.retire',{**request,'mode':'authority-target-v1'})
        self.adapter.retire.assert_called_once_with({'opId':'fixed','mode':'authority-target-v1'})

    def test_old_route_and_payload_are_unchanged(self):
        request={'limit':8}
        self.route('storage.archive.events',request)
        self.factory.assert_called_once_with()
        self.adapter.outbox_list.assert_called_once_with(request)

    def test_source_workers_and_public_overrides_cannot_select_context(self):
        for operation in ('storage.archive.events','storage.archive.ack','storage.archive.original',
                          'storage.archive.provision','storage.archive.enrollment-check','datasets.storage.certify'):
            with self.subTest(operation=operation),self.assertRaises(ValueError):
                self.route(operation,{'sourcePolicy':self.policy})
        for mode in ('authority-source-v1',None):
            with self.subTest(mode=mode),self.assertRaises(ValueError):
                self.route('storage.archive.retire',{'sourcePolicy':self.policy,'mode':mode})
        with self.assertRaises(ValueError):self.route('storage.archive.certify',{'sourcePolicy':None})
        self.factory.assert_not_called()


if __name__=='__main__':unittest.main()
