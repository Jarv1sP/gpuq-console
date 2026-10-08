"""Private server admission uses real isolated cache locks/metadata, never SSH."""
import base64
import ast
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import runpy
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

DEPLOY = Path(__file__).resolve().parents[1]/'deploy'


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, DEPLOY/filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


D = module('admission_dataset_cache', 'dataset-cache.py')
U = module('admission_dataset_upload', 'dataset-upload.py')
I = module('admission_dataset_ingress', 'dataset-ingress-node.py')


class ServerAdmission(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache = D.DatasetCache(Path(self.temp.name).resolve()/'cache', reserve_bytes=0)
        with self.cache._locked(): pass  # Existing lock inode is not an admission receipt.
        def workspace(user):
            if not isinstance(user, str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]{1,18})', user):
                raise ValueError('Invalid identity')
        self.node = SimpleNamespace(CONFIG={'datasets': {}, 'machine': 'warehouse-node',
            'storageArchive': {'enabled': True, 'machine': 'warehouse-node', 'authority': 'hdd'},
            'storageAuthority': {'enabled': True}}, dataset_cache=lambda: (D, self.cache),
            workspace=workspace, HERE=DEPLOY, ENV={}, run=lambda *a, **k: None)
        self.node.dataset_upload_location_cache=lambda:(D,self.cache)
        self.u = U.DatasetUploads(self.node)
        self.node.dataset_uploads = lambda: self.u
        active = patch.object(self.u, 'active', return_value=True)
        active.start(); self.addCleanup(active.stop)
        self.raw = json.dumps({'schema': 1, 'directories': [], 'files': [
            {'path': 'train.txt', 'size': 3, 'sha256': hashlib.sha256(b'abc').hexdigest()}]},
            separators=(',', ':'), ensure_ascii=False).encode()
        self.spec = dict(name='sample', manifestBytes=len(self.raw),
            manifestSha256=hashlib.sha256(self.raw).hexdigest(), totalBytes=3, entries=1)
        self.args = dict(userId='demo-user-1', hostAdmin=False, protocol=U.ADMISSION_PROTOCOL,
            intentKey=str(uuid.uuid4()), uploadId=str(uuid.uuid4()), requestedMachine='training-node',
            storageMachine='warehouse-node', authority='hdd', specification=self.spec,
            specificationSha256=self.digest(self.spec))

    @staticmethod
    def digest(spec):
        ordered = {key: spec[key] for key in U.SPECIFICATION_FIELDS}
        return hashlib.sha256(json.dumps(ordered, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()

    def admit(self, **changes):
        return I.admit(self.node, {**self.args, **changes})

    def public(self, action, **args):
        return self.u.process('datasets.upload.'+action,
            {'userId': self.args['userId'], 'hostAdmin': False, **args})

    def tree(self):
        return {str(path.relative_to(self.cache.root)): path.read_bytes()
                for path in self.cache.root.rglob('*') if path.is_file()}

    def marker(self):
        return self.u.admission_path(self.args['userId'], self.args['uploadId'])

    def test_fixed_authority_exact_spec_and_capacity_receipts_are_durable(self):
        result = self.admit()
        self.assertEqual({key: result[key] for key in ('admissionProtocol', 'admissionKey', 'authority', 'machine')},
            dict(admissionProtocol=1, admissionKey=self.args['intentKey'], authority='hdd', machine='warehouse-node'))
        self.assertEqual(result['uploadId'], self.args['uploadId'])
        receipt = D._read_json(self.marker())
        session = self.u.load(self.args['userId'], self.args['uploadId'])
        reserve = self.spec['totalBytes']+4*self.spec['manifestBytes']+8192*self.spec['entries']+65536
        self.assertEqual(receipt, session['serverAdmission'])
        self.assertEqual(receipt['rootIdentity'], list(self.cache._root_identity))
        self.assertEqual(receipt['specification'], self.spec)
        self.assertEqual(session['reserveBytes'], reserve)
        self.assertEqual(D._read_json(self.u.reservation(self.args['userId'], self.args['uploadId'])),
            dict(bytes=reserve, budgetBytes=reserve, inodes=self.spec['entries']+16))
        self.assertNotIn('serverAdmission', result)
        self.assertNotIn(str(self.cache.root), str(result))

    def test_lost_ack_is_same_uuid_and_does_not_reserve_twice(self):
        result = self.admit(); before = self.tree()
        self.assertEqual(self.admit(), result)
        self.assertEqual(self.tree(), before)
        located = I.locate(self.node, {key: self.args[key] for key in ('userId', 'uploadId')})
        self.assertTrue(located['present']); self.assertEqual(located['uploadAdmissionProtocol'], 1)
        self.assertEqual(located['specification'], self.spec)
        self.assertNotIn('intentKey', located)

    def test_every_immutable_tuple_change_is_refused_without_relabeling(self):
        self.admit(); before = self.tree()
        for changes in ({'intentKey': str(uuid.uuid4())}, {'requestedMachine': 'other-training'},
                        {'storageMachine': 'other-warehouse'}, {'authority': 'other-hdd'}):
            with self.subTest(changes=changes), self.assertRaises((ValueError, PermissionError)):
                self.admit(**changes)
            self.assertEqual(self.tree(), before)
        for key, value in (('name', 'other'), ('manifestBytes', len(self.raw)+1),
                           ('manifestSha256', 'b'*64), ('totalBytes', 4), ('entries', 2)):
            spec = {**self.spec, key: value}
            with self.subTest(field=key), self.assertRaises(ValueError):
                self.admit(specification=spec, specificationSha256=self.digest(spec))
            self.assertEqual(self.tree(), before)

    def test_digests_are_order_independent_and_match_fixed_json_stringify_bytes(self):
        spec = dict(reversed(list(self.spec.items())))
        self.admit(specification=spec)
        expected = ('{"name":"sample","manifestBytes":'+str(len(self.raw))+
            ',"manifestSha256":"'+self.spec['manifestSha256']+'","totalBytes":3,"entries":1}')
        self.assertEqual(self.args['specificationSha256'], hashlib.sha256(expected.encode('utf-8')).hexdigest())

    def test_invalid_public_private_fields_and_boolean_numbers_do_not_write(self):
        before = self.tree()
        cases = [{'hostAdmin': True}, {'protocol': 'dataset-upload-admission-v0'},
                 {'userId': '../../other'}, {'uploadId': str(uuid.uuid1())},
                 {'uploadId': self.args['uploadId'].upper()}, {'intentKey': 'bad'},
                 {'allowRelay': 1}, {'specificationSha256': 'b'*64}, {'root': '/tmp'},
                 {'serverAdmission': {}}, {'specification': {**self.spec, 'manifestBytes': True}},
                 {'specification': {**self.spec, 'totalBytes': True}},
                 {'specification': {**self.spec, 'entries': True}},
                 {'specification': {**self.spec, 'extra': 1}}]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(ValueError): self.admit(**changes)
            self.assertEqual(self.tree(), before)
        with self.assertRaises(ValueError):
            self.public('admit', **{key: value for key, value in self.args.items() if key not in ('userId', 'hostAdmin')})
        with self.assertRaises(ValueError):
            self.public('begin', key=self.args['uploadId'], **self.spec, serverAdmission={})
        self.assertEqual(self.tree(), before)

    def test_wrong_current_policy_cache_only_and_disabled_authority_fail_closed(self):
        original = copy.deepcopy(self.node.CONFIG); before = self.tree()
        for changes in ({'storageAuthority': {'enabled': False}}, {'storageTier': {'enabled': True}},
                        {'storageArchive': {'enabled': False}},
                        {'storageArchive': {'enabled': True, 'machine': 'other', 'authority': 'hdd'}},
                        {'storageArchive': {'enabled': True, 'machine': 'warehouse-node', 'authority': 'other'}}):
            self.node.CONFIG = {**original, **changes}
            with self.subTest(changes=changes), self.assertRaises(PermissionError): self.admit()
            self.assertEqual(self.tree(), before)

    def test_legacy_begin_remains_supported_but_existing_legacy_cannot_acquire_marker(self):
        self.public('begin', key=self.args['uploadId'], **self.spec)
        before = self.tree()
        with self.assertRaisesRegex(ValueError, 'legacy'): self.admit()
        self.assertEqual(self.tree(), before); self.assertFalse(self.marker().exists())
        self.assertEqual(self.public('begin', key=self.args['uploadId'], **self.spec)['uploadId'], self.args['uploadId'])

    def test_marker_present_bare_begin_is_not_a_private_admission_alias(self):
        self.admit(); before = self.tree()
        with self.assertRaisesRegex(ValueError, 'bare begin'):
            self.public('begin', key=self.args['uploadId'], **self.spec)
        self.assertEqual(self.tree(), before)

    def test_receipt_written_before_session_crash_is_unknown_not_absent_and_same_tuple_recovers(self):
        with patch.object(self.u, 'save', side_effect=OSError('simulated session write interruption')):
            with self.assertRaises(OSError): self.admit()
        self.assertTrue(self.marker().exists())
        with self.assertRaisesRegex(ValueError, 'absence is unconfirmed'):
            I.locate(self.node, {key: self.args[key] for key in ('userId', 'uploadId')})
        with self.assertRaisesRegex(ValueError, 'bare begin'):
            self.public('begin', key=self.args['uploadId'], **self.spec)
        self.assertEqual(self.admit()['uploadId'], self.args['uploadId'])
        self.assertEqual(self.u.load(self.args['userId'], self.args['uploadId'])['serverAdmission'], D._read_json(self.marker()))

    def test_session_written_before_reservation_crash_rechecks_capacity_before_repair(self):
        write = D._write_json; reservation = self.u.reservation(self.args['userId'], self.args['uploadId'])
        def interrupted(path, value, *args, **kwargs):
            if path == reservation: raise OSError('simulated reservation interruption')
            return write(path, value, *args, **kwargs)
        with patch.object(D, '_write_json', side_effect=interrupted):
            with self.assertRaises(OSError): self.admit()
        self.assertTrue(self.marker().exists()); self.assertFalse(reservation.exists())
        with patch.object(self.cache, '_free', side_effect=D.CacheError('space unavailable')):
            with self.assertRaises(D.CacheError): self.admit()
        self.assertFalse(reservation.exists())
        self.admit(); self.assertEqual(D._read_json(reservation), self.u.reservation_value(self.u.load(self.args['userId'], self.args['uploadId'])))

    def test_budget_free_space_and_inode_admission_precede_any_receipt(self):
        for method in ('_budget', '_free'):
            before = self.tree()
            with patch.object(self.cache, method, side_effect=D.CacheError('capacity unavailable')):
                with self.subTest(method=method), self.assertRaises(D.CacheError): self.admit()
            self.assertEqual(self.tree(), before); self.assertFalse(self.marker().exists())
        free = self.cache._free
        with patch.object(self.cache, '_free', wraps=free) as checked: self.admit()
        self.assertEqual(checked.call_args_list[0].kwargs, {'needed_inodes': self.spec['entries']+16})

    def test_user_and_session_limits_cannot_be_bypassed_by_private_admission(self):
        for limit, value in (('maxUserBytes', 1), ('maxUserEntries', 1)):
            self.u.limits[limit] = value
            spec = {**self.spec, 'entries': 2} if limit == 'maxUserEntries' else self.spec
            before = self.tree()
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                self.admit(specification=spec, specificationSha256=self.digest(spec))
            self.assertEqual(self.tree(), before)
            self.u.limits = {**U.DEFAULTS}
        self.u.limits['maxActiveUploads'] = 1; self.admit(); before = self.tree()
        with self.assertRaises(ValueError): self.admit(uploadId=str(uuid.uuid4()), intentKey=str(uuid.uuid4()))
        self.assertEqual(self.tree(), before)

    def test_orphan_and_unsafe_receipts_are_not_overwritten_or_false_absence(self):
        D._mkdir(self.marker().parent); D._write_json(self.marker(), None)
        with self.assertRaises(ValueError): self.admit()
        self.marker().unlink(); self.marker().symlink_to(self.cache.root/'missing')
        with self.assertRaises(OSError): self.admit()
        self.marker().unlink()
        reservation = self.u.reservation(self.args['userId'], self.args['uploadId'])
        D._mkdir(reservation.parent); reservation.symlink_to(self.cache.root/'missing')
        with self.assertRaises((OSError, ValueError)): self.admit()
        self.assertTrue(reservation.is_symlink()); self.assertFalse(self.marker().exists())

    def test_receipt_mutation_or_loss_blocks_status_manifest_and_location(self):
        self.admit(); receipt = D._read_json(self.marker())
        for changed in (None, {**receipt, 'intentKey': str(uuid.uuid4())},
                        {**receipt, 'rootIdentity': [0, 0]}, {**receipt, 'authority': 'other'}):
            D._write_json(self.marker(), changed)
            for action, args in (('status', {'uploadId': self.args['uploadId']}),
                                 ('manifest', {'uploadId': self.args['uploadId'], 'offset': 0,
                                               'data': base64.b64encode(self.raw).decode()})):
                with self.subTest(changed=changed, action=action), self.assertRaises(ValueError): self.public(action, **args)
            with self.assertRaises(ValueError): I.locate(self.node, {key: self.args[key] for key in ('userId', 'uploadId')})
        self.marker().unlink()
        with self.assertRaisesRegex(ValueError, 'missing'): self.public('status', uploadId=self.args['uploadId'])

    def test_cross_owner_is_not_adopted_and_current_policy_change_does_not_rewrite_original_tuple(self):
        self.admit(); before = self.tree()
        with self.assertRaises(FileNotFoundError):
            self.u.process('datasets.upload.status', dict(userId='demo-user-2', hostAdmin=False, uploadId=self.args['uploadId']))
        self.assertEqual(self.tree(), before)
        self.node.CONFIG['storageArchive']['authority'] = 'next-hdd'
        self.assertEqual(self.public('status', uploadId=self.args['uploadId'])['uploadId'], self.args['uploadId'])
        with self.assertRaises(PermissionError): self.admit()
        self.assertEqual(D._read_json(self.marker())['authority'], 'hdd')

    def test_public_manifest_uses_original_session_and_preserves_exact_receipt(self):
        self.admit(); receipt = self.marker().read_bytes()
        self.public('manifest', uploadId=self.args['uploadId'], offset=0, data=base64.b64encode(self.raw).decode())
        self.assertEqual(self.marker().read_bytes(), receipt)
        self.assertEqual((self.u.folder(self.args['userId'], self.args['uploadId'])/'manifest.part').read_bytes(), self.raw)
        self.assertEqual(self.u.load(self.args['userId'], self.args['uploadId'])['serverAdmission'], D._read_json(self.marker()))


class AdmissionBridge(unittest.TestCase):
    def setUp(self):
        inventory = json.dumps({'nodes': [{'id': 'fixture-node', 'user': 'fixture', 'address': '127.0.0.1'}]})
        original = Path.read_text
        def read(path, *args, **kwargs):
            return inventory if str(path) == '/opt/gpuq-console/inventory.json' else original(path, *args, **kwargs)
        with patch.object(Path, 'read_text', read):
            self.worker = runpy.run_path(str(DEPLOY/'execution-worker.py'), run_name='admission_bridge_fixture')

    def request(self, operation, machine='fixture-node', failure=None, reply=None):
        handler = self.worker['Handler'].__new__(self.worker['Handler'])
        handler.request = SimpleNamespace(settimeout=lambda value: None)
        args = dict(userId='demo-user-1', hostAdmin=False, uploadId=str(uuid.uuid4()), protocol=U.ADMISSION_PROTOCOL)
        handler.rfile = io.BytesIO((json.dumps(dict(machine=machine, operation=operation, args=args))+'\n').encode())
        handler.wfile = io.BytesIO()
        response = dict(ok=True, result=dict(admissionProtocol=1)) if reply is None else reply
        with patch.object(self.worker['SSH_CONNECTIONS'], 'call', side_effect=failure,
                return_value=SimpleNamespace(returncode=0, stdout=json.dumps(response))) as call:
            handler.handle()
        return json.loads(handler.wfile.getvalue()), call, args

    def test_exact_private_operation_is_transported_once_with_unchanged_tuple(self):
        self.assertIn('storage.upload.admit', self.worker['INTERNAL_STORAGE'])
        response, call, args = self.request('storage.upload.admit')
        self.assertTrue(response['ok']); call.assert_called_once()
        self.assertEqual(call.call_args.args[1], dict(operation='storage.upload.admit', args=args))

    def test_unknown_alias_or_host_is_zero_transport_and_refusal_is_preserved(self):
        for operation, machine in (('storage.upload.admit.extra', 'fixture-node'),
                                   ('storage.upload.admit', 'unknown'), ('datasets.upload.admit', 'fixture-node')):
            with self.subTest(operation=operation, machine=machine):
                response, call, _ = self.request(operation, machine)
                self.assertFalse(response['ok']); call.assert_not_called()
        refusal = dict(ok=False, error='different authority')
        response, call, _ = self.request('storage.upload.admit', reply=refusal)
        self.assertEqual(response, refusal); call.assert_called_once()

    def test_ambiguous_private_admission_timeout_is_never_replayed(self):
        response, call, _ = self.request('storage.upload.admit', failure=subprocess.TimeoutExpired('fixture', 1))
        self.assertFalse(response['ok']); call.assert_called_once()

    def test_dedicated_node_forced_mode_is_literal_upload_only_before_dispatch(self):
        tree = ast.parse((DEPLOY/'node-executor.py').read_text())
        constants = [value for value in tree.body if isinstance(value, ast.Assign)
                     and any(isinstance(target, ast.Name) and target.id == 'UPLOAD_INGRESS_OPERATIONS' for target in value.targets)]
        guard = next(value for value in tree.body if isinstance(value, ast.FunctionDef)
                     and value.name == 'require_upload_ingress_operation')
        namespace = {}
        exec(compile(ast.Module(body=constants+[guard], type_ignores=[]), '<dedicated forced ingress>', 'exec'), namespace)
        self.assertEqual(set(namespace['UPLOAD_INGRESS_OPERATIONS']), {
            'storage.upload.admit', 'storage.upload.locate', 'datasets.upload.begin', 'datasets.upload.manifest',
            'datasets.upload.seal', 'datasets.upload.status', 'datasets.upload.chunk', 'datasets.upload.commit',
            'datasets.upload.discard', 'datasets.upload.pause', 'datasets.upload.routes',
            'datasets.upload.direct-ticket', 'datasets.upload.direct-revoke'})
        for operation in namespace['UPLOAD_INGRESS_OPERATIONS']: namespace['require_upload_ingress_operation'](operation)
        for operation in ('sync', 'cancel', 'host.exec', 'terminal.exchange', 'storage.archive.retire',
                          'storage.upload.admit.extra', 'datasets.upload.admit'):
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                namespace['require_upload_ingress_operation'](operation)
        source = (DEPLOY/'node-executor.py').read_text()
        self.assertLess(source.rindex("if upload_ingress_only:require_upload_ingress_operation"),
                        source.rindex("result=process(data['operation'],data['args'])"))
        self.assertIn("if upload_ingress_only:raise ValueError('Terminal streams are not allowed", source)


if __name__ == '__main__': unittest.main()
