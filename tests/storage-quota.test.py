import copy
import hashlib
import importlib.util
import json
import os
import sqlite3
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

S = importlib.util.spec_from_file_location('quota_test', Path(__file__).resolve().parents[1]/'deploy/storage-quota.py')
q = importlib.util.module_from_spec(S)
S.loader.exec_module(q)
USER = 'demo-user-3'
UID = 1000


def policy(root='/srv/gpuq'):
    return {'schema': 1, 'serviceUid': UID, 'platformRoot': root, 'datasetsRoot': root+'/datasets',
            'volumes': {'data': {'uuid': '11111111-1111-1111-1111-111111111111', 'mountPoint': '/srv', 'filesystem': 'ext4'}},
            'owners': {USER: {'projectId': 10003, 'limits': {'data': {'bytes': 1048576, 'inodes': 100}}}}}


class QuotaTests(unittest.TestCase):
    def test_default_disabled_does_not_spawn_or_touch_paths(self):
        with patch.object(q.subprocess, 'run', side_effect=AssertionError):
            self.assertEqual(q.ensure({}, USER, '/missing')['enabled'], False)

    def test_enabled_is_not_truthy_and_unknown_keys_fail(self):
        for value in (None, True, {'enabled': 1}, {'enabled': 'true'}, {'enabled': True, 'helper': '/evil'}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                q.enabled({'storageQuota': value})

    def test_cohort_is_explicit_finite_unique_and_authenticated(self):
        config = {'storageQuota': {'enabled': True, 'owners': [USER]}}
        self.assertTrue(q.enabled(config, USER))
        self.assertFalse(q.enabled(config, 'demo-user-4'))
        for user in (None, 'scheduler', '../demo-user-3', False):
            with self.subTest(user=user), self.assertRaises(ValueError): q.enabled(config, user)
        for owners in ([], [USER, USER], ['scheduler'], [False], USER, None):
            with self.subTest(owners=owners), self.assertRaises(ValueError):
                q.enabled({'storageQuota': {'enabled': True, 'owners': owners}}, USER)
        with self.assertRaises(ValueError): q.enabled({'storageQuota': {'enabled': False, 'owners': [USER]}}, USER)

    def test_excluded_owner_has_unknown_status_and_no_broker_or_path_touch(self):
        config = {'storageQuota': {'enabled': True, 'owners': ['demo-user-4']}}
        with patch.object(q.subprocess, 'run', side_effect=AssertionError), patch.object(q, 'directory', side_effect=AssertionError):
            self.assertEqual(q.ensure(config, USER, '/missing'), {'enabled': False, 'enforcement': None})
            self.assertEqual(q.status(config, USER), {'enabled': False, 'enforcement': None,
                             'owner': USER, 'volumes': None, 'reason': 'OWNER_NOT_ACTIVATED'})
            q.ensure_attempt(config, {'userId': USER}, {})

    def test_selected_owner_keeps_strict_broker_and_attempt_admission(self):
        config = {'storageQuota': {'enabled': True, 'owners': [USER]}}
        with patch.object(q.subprocess, 'run', return_value=Mock(returncode=1, stdout='')) as broker:
            with self.assertRaisesRegex(ValueError, 'write admission refused'): q.ensure(config, USER, '/missing')
            with self.assertRaisesRegex(ValueError, 'usage is unknown'): q.status(config, USER)
            self.assertEqual(broker.call_count, 2)
        with self.assertRaisesRegex(ValueError, 'Missing scheduler'): q.ensure_attempt(config, {'userId': USER}, {})

    def test_dataset_cohort_never_guesses_shared_or_legacy_billing(self):
        config = {'storageQuota': {'enabled': True, 'owners': [USER]}}
        self.assertEqual(q.dataset_owner(config, USER, [USER]), USER)
        self.assertEqual(q.dataset_owner(config, 'builtin-admin', [USER]), USER)
        self.assertIsNone(q.dataset_owner(config, 'demo-user-4', ['demo-user-4', 'demo-user-5']))
        for actor, owners in ((USER, [USER, 'demo-user-4']), ('demo-user-4', [USER, 'demo-user-4']),
                              (USER, ['demo-user-4']), (USER, [USER, USER]), ('scheduler', [USER])):
            with self.subTest(actor=actor, owners=owners), self.assertRaises(ValueError): q.dataset_owner(config, actor, owners)
        with self.assertRaisesRegex(ValueError, 'Shared dataset'):
            q.dataset_owner({'storageQuota': {'enabled': True}}, 'demo-user-4', ['demo-user-4', 'demo-user-5'])
        self.assertIsNone(q.dataset_owner({}, 'scheduler', ['scheduler']))

    def test_exact_owner_and_project_id_policy(self):
        self.assertEqual(q.validate_policy(policy())['owners'][USER]['projectId'], 10003)
        for alter in ('zero', 'duplicate', 'unlimited', 'bool', 'unaligned'):
            p = policy()
            if alter == 'zero': p['owners'][USER]['projectId'] = 0
            if alter == 'duplicate': p['owners']['demo-user-4'] = copy.deepcopy(p['owners'][USER])
            if alter == 'unlimited': p['owners'][USER]['limits']['data']['inodes'] = 0
            if alter == 'bool': p['owners'][USER]['limits']['data']['inodes'] = True
            if alter == 'unaligned': p['owners'][USER]['limits']['data']['bytes'] = 12345
            with self.subTest(alter=alter), self.assertRaises(ValueError): q.validate_policy(p)

    def test_missing_owner_is_not_guessed_admin(self):
        with self.assertRaisesRegex(ValueError, 'No administrator'):
            q.quota_owner(policy(), 'builtin-admin')

    def test_fixed_owner_roots_not_arbitrary_paths(self):
        digest = hashlib.sha256(USER.encode()).hexdigest()
        p = policy()
        for path in ('/srv/gpuq/users/'+digest[:32], '/srv/gpuq/projects-v2/'+digest,
                     '/srv/gpuq/oci/'+digest, '/srv/gpuq/datasets/.uploads/'+digest,
                     '/srv/gpuq/datasets/.workspaces/'+digest):
            self.assertEqual(q.allowed_path(p, USER, path), 'owner-root')
        for path in ('/etc', '/srv/gpuq', '/srv/gpuq/users/'+'f'*32, '/srv/gpuq/oci/'+digest+'/../x'):
            with self.subTest(path=path), self.assertRaises(ValueError): q.allowed_path(p, USER, path)

    def test_symlink_ancestor_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            (base/'real').mkdir(); (base/'link').symlink_to(base/'real')
            with self.assertRaises(OSError):
                with q.directory(base/'link'): pass

    def test_broker_rejects_caller_limits_and_project_id(self):
        with patch.object(q.os, 'geteuid', return_value=0):
            for extra in ({'projectId': 1}, {'limitBytes': 0}, {'command': 'quotaoff'}):
                with self.assertRaisesRegex(ValueError, 'Invalid quota request'):
                    q.broker({'userId': USER, 'path': '/srv/gpuq', **extra}, policy())

    def test_project_upload_key_matches_existing_protocol(self):
        key = hashlib.sha256(json.dumps([USER, 'vision']).encode()).hexdigest()
        with patch.object(q.os, 'geteuid', return_value=0):
            with self.assertRaisesRegex(ValueError, 'owner mismatch'):
                q.broker({'userId': USER, 'path': '/srv/gpuq/project-ops/'+key+'.uploads', 'project': 'other'}, policy())

    def test_quota_info_failure_does_not_fall_back_to_free_space(self):
        with patch.object(q.subprocess, 'run', return_value=Mock(returncode=1, stdout='')), self.assertRaisesRegex(ValueError, 'write admission refused'):
            q.ensure({'storageQuota': {'enabled': True}}, USER, '/srv/gpuq')

    def test_forged_unlimited_response_rejected(self):
        value = {'enabled': True, 'enforcement': 'kernel-project-quota', 'projectId': 10003, 'bytes': 0, 'inodes': 100}
        with patch.object(q.subprocess, 'run', return_value=Mock(returncode=0, stdout=json.dumps(value))), self.assertRaises(ValueError):
            q.ensure({'storageQuota': {'enabled': True}}, USER, '/srv/gpuq')

    def test_mount_noquota_and_accounting_only_are_rejected(self):
        for flags in ('rw,noquota', 'rw,pqnoenforce', 'rw,relatime'):
            row = {'uuid': policy()['volumes']['data']['uuid'], 'fstype': 'ext4', 'options': flags}
            with patch.object(q.subprocess, 'run', return_value=Mock(stdout=json.dumps({'filesystems': [row]}))), self.assertRaisesRegex(ValueError, 'enforcement'):
                q.volume_for(policy(), '/srv/gpuq')

    def test_quota_struct_uses_64_bit_kernel_units(self):
        self.assertEqual(q.ctypes.sizeof(q.Dqblk), 72)
        calls = []
        def syscall(command, device, project, address):
            calls.append((command.value, project.value))
            value = q.ctypes.cast(address, q.ctypes.POINTER(q.Dqblk)).contents
            if len(calls) == 1:
                self.assertEqual(value.bhard, 1024)
                self.assertEqual(value.ihard, 100)
                self.assertEqual(value.valid, 5)
            return 0
        with patch.object(q.ctypes, 'CDLL', return_value=Mock(quotactl=syscall)):
            q.quotactl('/dev/a', 10003, {'bytes': 1048576, 'inodes': 100})
        self.assertEqual(calls[0][1], 10003)

    def test_diagnostic_owner_comes_from_stored_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve(); (root/'jobs').mkdir()
            job='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
            spec=root/'jobs'/(job+'.json');spec.write_text(json.dumps({'id':job,'userId':USER}));spec.chmod(0o600)
            p=policy(str(root));p['serviceUid']=os.getuid()
            path=root/'diagnostics'/job/('b'*32)/'runtime'
            self.assertEqual(q.allowed_path(p,USER,path),'diagnostic-runtime')
            spec.write_text(json.dumps({'id':job,'userId':'demo-user-4'}))
            with self.assertRaisesRegex(ValueError,'owner mismatch'):q.allowed_path(p,USER,path)

    def test_scheduler_attempt_joins_native_submit_key_and_platform_owner(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();(root/'jobs').mkdir()
            job='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';attempt='A'+'b'*32
            record=root/'jobs'/(job+'.json');record.write_text(json.dumps({'id':job,'userId':USER}));record.chmod(0o600)
            database=root/'state.sqlite3'
            with sqlite3.connect(database) as db:
                db.executescript('CREATE TABLE jobs(id TEXT,submit_key TEXT);CREATE TABLE attempts(id TEXT,job_id TEXT,control_dir TEXT);')
                db.execute('INSERT INTO jobs VALUES(?,?)',('J123',job))
                db.execute('INSERT INTO attempts VALUES(?,?,?)',(attempt,'J123',str(root/'control'/attempt)))
            database.chmod(0o600)
            p=policy(str(root));p.update(serviceUid=os.getuid(),controlRoot=str(root/'control'),database=str(database))
            self.assertEqual(q.allowed_path(p,USER,root/'control'/attempt),'scheduler-control')
            with self.assertRaisesRegex(ValueError,'Unknown scheduler'):q.allowed_path(p,USER,root/'control'/('A'+'c'*32))

    def test_attempt_charging_rejects_hardlinks_without_deleting(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();root.chmod(0o700)
            (root/'one').write_bytes(b'x');(root/'one').chmod(0o600);os.link(root/'one',root/'two')
            with q.directory(root) as fd,patch.object(q,'attribute',return_value=(10003,True)):
                with self.assertRaisesRegex(ValueError,'explicit administration'):q.charge_attempt(fd,10003,os.getuid())
            self.assertEqual((root/'one').read_bytes(),b'x')

    def test_attempt_charging_rejects_unknown_project_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();root.chmod(0o700)
            with q.directory(root) as fd,patch.object(q,'attribute',return_value=(10004,True)):
                with self.assertRaisesRegex(ValueError,'different quota owner'):q.charge_attempt(fd,10003,os.getuid())

    def test_native_stdout_log_is_bound_to_attempt_and_platform_owner(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve(); (root/'jobs').mkdir(); (root/'logs').mkdir()
            job='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; attempt='A'+'b'*32
            record=root/'jobs'/(job+'.json'); record.write_text(json.dumps({'id':job,'userId':USER})); record.chmod(0o600)
            path=root/'logs'/('J123-'+attempt+'.log'); database=root/'state.sqlite3'
            with sqlite3.connect(database) as db:
                db.executescript('CREATE TABLE jobs(id TEXT,submit_key TEXT);CREATE TABLE attempts(id TEXT,job_id TEXT,log_path TEXT);')
                db.execute('INSERT INTO jobs VALUES(?,?)',('J123',job))
                db.execute('INSERT INTO attempts VALUES(?,?,?)',(attempt,'J123',str(path)))
            database.chmod(0o600)
            p=policy(str(root)); p.update(serviceUid=os.getuid(),database=str(database),logRoot=str(root/'logs'))
            self.assertEqual(q.allowed_path(p,USER,path),'scheduler-log')
            with self.assertRaisesRegex(ValueError,'owner mismatch'):q.allowed_path(p,USER,root/'logs'/('J456-'+attempt+'.log'))
            record.write_text(json.dumps({'id':job,'userId':'demo-user-4'}))
            with self.assertRaisesRegex(ValueError,'owner mismatch'):q.allowed_path(p,USER,path)

    def test_log_quota_assignment_preserves_content_and_rejects_hardlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp).resolve()/'log'; path.write_bytes(b'first output'); path.chmod(0o600)
            fd=os.open(path,os.O_RDONLY)
            try:
                with patch.object(q,'attribute',side_effect=[(0,False),(10003,False),(10003,False)]) as attr:
                    got=q.admit_target(fd,'scheduler-log',{'serviceUid':os.getuid()}, {'projectId':10003}, 'data',
                                       {'bytes':1048576,'inodes':100,'usedBytes':0,'usedInodes':0})
                self.assertEqual(got['kind'],'scheduler-log')
                attr.assert_any_call(fd,10003,inherit=False)
                self.assertEqual(path.read_bytes(),b'first output')
                os.link(path,path.with_name('other'))
                with patch.object(q,'attribute',return_value=(10003,False)),self.assertRaisesRegex(ValueError,'explicit quota migration'):
                    q.admit_target(fd,'scheduler-log',{'serviceUid':os.getuid()}, {'projectId':10003}, 'data', {})
            finally: os.close(fd)

    def test_training_log_admission_fails_before_payload_if_native_identity_is_missing(self):
        with self.assertRaisesRegex(ValueError,'Missing scheduler log quota identity'):
            q.ensure_attempt({'storageQuota':{'enabled':True}}, {'userId':USER,'id':'a'*36}, {})

    def test_disabled_status_is_unknown_usage_and_never_spawns(self):
        with patch.object(q.subprocess,'run',side_effect=AssertionError):
            got=q.status({},USER)
        self.assertEqual(got,{'enabled':False,'enforcement':None,'owner':USER,'volumes':None})

    def test_kernel_status_is_read_only_and_uses_actual_counters(self):
        actual={'bytes':1048576,'inodes':100,'usedBytes':12288,'usedInodes':7}
        with patch.object(q,'check_guard',return_value={'guarded':True}),patch.object(q,'volume_for',return_value=('data','/dev/a')),patch.object(q,'quotactl',return_value=actual) as call,patch.object(q,'attribute',side_effect=AssertionError):
            got=q.kernel_status(policy(),USER)
        call.assert_called_once_with('/dev/a',10003)
        self.assertEqual(got['volumes'][0]['usedBytes'],12288);self.assertEqual(got['volumes'][0]['remainingInodes'],93)
        self.assertEqual(set(got),{'enabled','enforcement','owner','projectId','volumes'})

    def test_status_request_cannot_supply_path_id_limits_or_other_identity_fields(self):
        with patch.object(q.os,'geteuid',return_value=0):
            for extra in ({'path':'/etc'},{'projectId':10004},{'bytes':0},{'hostAdmin':True}):
                with self.assertRaisesRegex(ValueError,'status request'):q.broker({'operation':'status','userId':USER,**extra},policy())

    def test_status_missing_owner_and_kernel_drift_are_unknown_not_empty(self):
        with self.assertRaisesRegex(ValueError,'No administrator'):q.kernel_status(policy(),'demo-user-4')
        with patch.object(q,'check_guard',return_value={'guarded':True}),patch.object(q,'volume_for',return_value=('data','/dev/a')),patch.object(q,'quotactl',return_value={'bytes':0,'inodes':100,'usedBytes':0,'usedInodes':0}):
            with self.assertRaisesRegex(ValueError,'does not match'):q.kernel_status(policy(),USER)

    def test_client_status_owner_and_counters_are_strict(self):
        value={'enabled':True,'enforcement':'kernel-project-quota','owner':USER,'projectId':10003,
               'volumes':[{'volume':'data','bytes':1048576,'inodes':100,'usedBytes':12288,'usedInodes':7,'remainingBytes':1036288,'remainingInodes':93}]}
        with patch.object(q.subprocess,'run',return_value=Mock(returncode=0,stdout=json.dumps(value))) as proc:
            self.assertEqual(q.status({'storageQuota':{'enabled':True}},USER),value)
            self.assertEqual(json.loads(proc.call_args.kwargs['input']),{'operation':'status','userId':USER})
        for alter in ('owner','remaining','duplicate','bool','path'):
            bad=copy.deepcopy(value)
            if alter=='owner':bad['owner']='demo-user-4'
            if alter=='remaining':bad['volumes'][0]['remainingBytes']=0
            if alter=='duplicate':bad['volumes'].append(copy.deepcopy(bad['volumes'][0]))
            if alter=='bool':bad['volumes'][0]['usedInodes']=False
            if alter=='path':bad['path']='/srv/data'
            with self.subTest(alter=alter),patch.object(q.subprocess,'run',return_value=Mock(returncode=0,stdout=json.dumps(bad))),self.assertRaises(ValueError):q.status({'storageQuota':{'enabled':True}},USER)

    def test_training_status_is_distinct_read_only_and_old_status_shape_is_unchanged(self):
        old={'enabled':True,'enforcement':'kernel-project-quota','owner':USER,'projectId':10003,
             'volumes':[{'volume':'data','bytes':1048576,'inodes':100,'usedBytes':12288,'usedInodes':7,
                         'remainingBytes':1036288,'remainingInodes':93}]}
        new=copy.deepcopy(old);new['volumes'][0]['volumeDeviceId']='a'*64
        with patch.object(q.subprocess,'run',return_value=Mock(returncode=0,stdout=json.dumps(new))) as proc:
            self.assertEqual(q.training_status({'storageQuota':{'enabled':True}},USER),new)
            self.assertEqual(json.loads(proc.call_args.kwargs['input']),{'operation':'training-status','userId':USER})
            proc.assert_called_once()
        # A legacy broker is unknown, never retried as the less precise status.
        with patch.object(q.subprocess,'run',return_value=Mock(returncode=0,stdout=json.dumps(old))) as proc:
            with self.assertRaisesRegex(ValueError,'counters'):q.training_status({'storageQuota':{'enabled':True}},USER)
            proc.assert_called_once()
        with patch.object(q.subprocess,'run',return_value=Mock(returncode=0,stdout=json.dumps(old))) as proc:
            self.assertEqual(q.status({'storageQuota':{'enabled':True}},USER),old)
            self.assertEqual(json.loads(proc.call_args.kwargs['input']),{'operation':'status','userId':USER})

    def test_training_status_identity_unknown_and_injected_request_fields_reject(self):
        value={'enabled':True,'enforcement':'kernel-project-quota','owner':USER,'projectId':10003,
               'volumes':[{'volume':'data','volumeDeviceId':'a'*64,'bytes':1048576,'inodes':100,'usedBytes':12288,
                           'usedInodes':7,'remainingBytes':1036288,'remainingInodes':93}]}
        for identity in (None,'/dev/private','a'*63,False):
            bad=copy.deepcopy(value);bad['volumes'][0]['volumeDeviceId']=identity
            with self.subTest(identity=identity),patch.object(q.subprocess,'run',return_value=Mock(returncode=0,stdout=json.dumps(bad))),self.assertRaises(ValueError):
                q.training_status({'storageQuota':{'enabled':True}},USER)
        with patch.object(q.os,'geteuid',return_value=0):
            for extra in ({'path':'/etc'},{'projectId':10004},{'bytes':0},{'hostAdmin':True}):
                with self.assertRaisesRegex(ValueError,'status request'):
                    q.broker({'operation':'training-status','userId':USER,**extra},policy())

    def test_training_kernel_counters_bind_the_actual_no_follow_device_without_write(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as temp:
            volume=Path(temp);p=policy();p['volumes']['data']['mountPoint']=str(volume)
            actual={'bytes':1048576,'inodes':100,'usedBytes':12288,'usedInodes':7}
            original=os.stat;device=volume.stat().st_dev
            def stat(path,*args,**kwargs):
                return Mock(st_rdev=device) if path=='/dev/fixture' else original(path,*args,**kwargs)
            with patch.object(q,'check_guard',return_value={'guarded':True}),patch.object(q,'volume_for',return_value=('data','/dev/fixture')),patch.object(q,'quotactl',return_value=actual) as read,patch.object(q.os,'stat',side_effect=stat),patch.object(q,'admit_target',side_effect=AssertionError('no writes')):
                result=q.kernel_status(p,USER,training=True)
            read.assert_called_once_with('/dev/fixture',10003)
            self.assertEqual(result['volumes'][0]['volumeDeviceId'],hashlib.sha256(str(device).encode()).hexdigest())
            self.assertEqual(result['volumes'][0]['usedBytes'],actual['usedBytes'])


if __name__ == '__main__': unittest.main()
