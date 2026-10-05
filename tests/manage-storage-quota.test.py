"""Offline CAS/lifecycle tests. Mocked kernel counters are not EDQUOT acceptance."""
import contextlib
import copy
import hashlib
import importlib.util
import json
import os
import io
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parents[1]/'deploy'
spec=importlib.util.spec_from_file_location('quota_manage_test',HERE/'manage-storage-quota.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
USER='demo-user-3'


def policy(root='/srv/gpuq'):
    return {'schema':1,'serviceUid':1000,'platformRoot':root,'datasetsRoot':root+'/datasets',
            'volumes':{'data':{'uuid':'11111111-1111-1111-1111-111111111111','mountPoint':'/srv','filesystem':'xfs'}},
            'owners':{USER:{'projectId':10003,'limits':{'data':{'bytes':1048576,'inodes':100}}}}}


def metadata(p):
    return {'path':str(m.q.POLICY),'sha256':m.sha(m.canonical(p)),
            'identity':[1,2,stat.S_IFREG|0o600,0,0,1,200,3,4]}


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.old=policy(); self.raw=m.canonical(self.old); self.meta=metadata(self.old)
        self.counters={10003:{'bytes':1048576,'inodes':100,'usedBytes':4096,'usedInodes':3}}
        self.gate={'fence':{'sha256':'a'*64},'idleProcesses':[],'rootGuard':{'guarded':True}}
        self.patches=[patch.object(m,'policy_state',side_effect=lambda:(copy.deepcopy(self.old),self.raw,copy.deepcopy(self.meta))),
                      patch.object(m,'offline_gate',return_value=self.gate),
                      patch.object(m.q,'volume_for',return_value=('data','/dev/test')),
                      patch.object(m.q,'quotactl',side_effect=self.quota)]
        for item in self.patches:item.start()
        self.sets=[]
    def tearDown(self):
        for item in reversed(self.patches):item.stop()
    def quota(self,device,project,limit=None):
        row=self.counters.setdefault(project,{'bytes':0,'inodes':0,'usedBytes':0,'usedInodes':0})
        if limit is not None:self.sets.append((project,copy.deepcopy(limit)));row.update(limit)
        return row.copy()
    def candidate(self):
        p=copy.deepcopy(self.old);p['owners'][USER]['limits']['data']['bytes']=2097152;return p
    def test_plan_preserves_identity_and_is_read_only(self):
        value=m.policy_plan(self.candidate())
        self.assertEqual(value['operation'],'policy');self.assertEqual(value['changes'][0]['before']['usedBytes'],4096)
        self.assertEqual(self.sets,[]);self.assertFalse(value['featuresEnabled']);self.assertFalse(value['mountsChanged'])
    def test_add_owner_uses_new_zero_usage_project_id(self):
        p=copy.deepcopy(self.old);p['owners']['demo-user-4']={'projectId':10004,'limits':{'data':{'bytes':1048576,'inodes':100}}}
        value=m.policy_plan(p);self.assertEqual(value['changes'][0]['owner'],'demo-user-4');self.assertEqual(self.sets,[])
    def test_reused_new_owner_id_with_usage_is_rejected(self):
        p=copy.deepcopy(self.old);p['owners']['demo-user-4']={'projectId':10004,'limits':{'data':{'bytes':1048576,'inodes':100}}}
        self.counters[10004]={'bytes':0,'inodes':0,'usedBytes':4096,'usedInodes':1}
        with self.assertRaisesRegex(ValueError,'already used'):m.policy_plan(p)
    def test_roots_or_volume_identity_cannot_change(self):
        for key in ('platformRoot','datasetsRoot','serviceUid','volumes'):
            p=self.candidate()
            p[key]={'data':{**p['volumes']['data'],'uuid':'22222222-2222-2222-2222-222222222222'}} if key=='volumes' else 1001 if key=='serviceUid' else '/srv/other'
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'cannot change'):m.policy_plan(p)
    def test_owner_delete_and_id_changes_are_rejected(self):
        p=self.candidate();del p['owners'][USER]
        with self.assertRaisesRegex(ValueError,'deletion'):m.policy_plan(p)
        p=self.candidate();p['owners'][USER]['projectId']=10004
        with self.assertRaisesRegex(ValueError,'project ID'):m.policy_plan(p)
    def test_lowering_below_kernel_usage_is_rejected(self):
        for field,value in (('bytes',1024),('inodes',2)):
            p=self.candidate();p['owners'][USER]['limits']['data'][field]=value
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'below'):m.policy_plan(p)
    def test_drifted_kernel_policy_is_not_repaired_silently(self):
        self.counters[10003]['bytes']=8192
        with self.assertRaisesRegex(ValueError,'drifted'):m.policy_plan(self.candidate())
    def test_missing_owner_and_invalid_finite_limits_fail(self):
        p=self.candidate();p['owners'][USER]['limits']['data']['inodes']=0
        with self.assertRaises(ValueError):m.policy_plan(p)
    def test_unchanged_policy_is_not_a_mutation(self):
        with self.assertRaisesRegex(ValueError,'no limit changes'):m.policy_plan(self.old)
    def test_exact_approved_plan_required_before_lock_or_intent(self):
        plan=m.policy_plan(self.candidate())
        with patch.object(m.os,'geteuid',return_value=0),patch.object(m,'administration_lock',side_effect=AssertionError):
            with self.assertRaisesRegex(ValueError,'Approved'):m.execute(plan,'f'*64)
    def test_fresh_counter_cas_failure_creates_no_intent(self):
        plan=m.policy_plan(self.candidate()); self.counters[10003]['usedBytes']=8192
        with tempfile.TemporaryDirectory() as tmp,patch.object(m,'CONTROL',Path(tmp).resolve()/'control'),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'administration_lock',return_value=contextlib.nullcontext()):
            with self.assertRaisesRegex(ValueError,'CAS changed'):m.execute(plan,m.sha(m.canonical(plan)))
            self.assertFalse(m.CONTROL.exists());self.assertEqual(self.sets,[])
    def test_success_keeps_exact_backup_and_cannot_replay_intent(self):
        plan=m.policy_plan(self.candidate());digest=m.sha(m.canonical(plan));published=[]
        with tempfile.TemporaryDirectory() as tmp,patch.object(m,'CONTROL',Path(tmp).resolve()/'control'),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'administration_lock',return_value=contextlib.nullcontext()),patch.object(m.c,'protected_directory',side_effect=lambda p:p.mkdir(exist_ok=True)),patch.object(m,'publish_policy',side_effect=lambda raw,meta:published.append((raw,meta))):
            got=m.execute(plan,digest)
            self.assertEqual(got['phase'],'POLICY_UPDATED');self.assertEqual((m.CONTROL/digest/'policy-before.json').read_bytes(),self.raw)
            self.assertEqual(published,[(m.canonical(plan['candidate']),self.meta)])
            # Restore only the mock kernel for this explicit replay test. The
            # real tool neither rolls it back nor replays a pending directory.
            self.counters[10003]['bytes']=1048576
            with self.assertRaises(FileExistsError):m.execute(plan,digest)
            self.assertEqual(len(self.sets),1)
    def test_partial_kernel_failure_retains_original_policy_and_failed_receipt(self):
        plan=m.policy_plan(self.candidate());digest=m.sha(m.canonical(plan))
        def broken(device,project,limit=None):
            if limit is not None:raise OSError('synthetic kernel failure')
            return self.counters[project].copy()
        with tempfile.TemporaryDirectory() as tmp,patch.object(m,'CONTROL',Path(tmp).resolve()/'control'),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'administration_lock',return_value=contextlib.nullcontext()),patch.object(m.c,'protected_directory',side_effect=lambda p:p.mkdir(exist_ok=True)),patch.object(m,'publish_policy',side_effect=AssertionError),patch.object(m.q,'quotactl',side_effect=broken):
            with self.assertRaises(OSError):m.execute(plan,digest)
            receipt=json.loads((m.CONTROL/digest/'receipt.json').read_bytes())
            self.assertEqual(receipt['phase'],'REVIEW_REQUIRED');self.assertEqual((m.CONTROL/digest/'policy-before.json').read_bytes(),self.raw)
            with self.assertRaises(FileExistsError):m.execute(plan,digest)
    def test_root_required_to_execute(self):
        with patch.object(m.os,'geteuid',return_value=1000),self.assertRaisesRegex(ValueError,'administrator'):m.execute({},'a'*64)
    def test_policy_schema_does_not_accept_boolean(self):
        p=self.candidate();p['schema']=True
        with self.assertRaisesRegex(ValueError,'schema'):m.policy_plan(p)
    def test_migration_binds_fixed_owner_root_and_budget(self):
        path='/srv/gpuq/users/'+hashlib.sha256(USER.encode()).hexdigest()[:32]
        tree={'sha256':'d'*64,'entries':3,'uniqueInodes':3,'unassignedBytes':4096,'unassignedInodes':3,'internalHardlinkGroups':0}
        with patch.object(m,'tree_snapshot',return_value=([],tree)):
            value=m.migration_plan(USER,path);self.assertEqual(value['path'],path);self.assertEqual(value['projectId'],10003)
            with self.assertRaises(ValueError):m.migration_plan(USER,'/srv/gpuq/users/'+'f'*32)
            with self.assertRaisesRegex(ValueError,'Unexpected'):m.migration_plan(USER,path,'extra')
        with patch.object(m,'tree_snapshot',return_value=([],{**tree,'unassignedBytes':1048576})),self.assertRaisesRegex(ValueError,'exceeds'):m.migration_plan(USER,path)
    def test_project_upload_migration_uses_exact_owner_slug_key(self):
        key=hashlib.sha256(json.dumps([USER,'vision']).encode()).hexdigest();path='/srv/gpuq/project-ops/'+key+'.uploads'
        tree={'sha256':'d'*64,'entries':1,'uniqueInodes':1,'unassignedBytes':0,'unassignedInodes':1,'internalHardlinkGroups':0}
        with patch.object(m,'tree_snapshot',return_value=([],tree)):
            self.assertEqual(m.migration_plan(USER,path,'vision')['kind'],'project-upload')
            with self.assertRaisesRegex(ValueError,'slug'):m.migration_plan(USER,path)
            with self.assertRaisesRegex(ValueError,'owner mismatch'):m.migration_plan(USER,path,'another')
    def test_migration_plan_rejects_unknown_owner_and_kernel_drift(self):
        path='/srv/gpuq/users/'+hashlib.sha256(USER.encode()).hexdigest()[:32]
        with self.assertRaisesRegex(ValueError,'No administrator'):m.migration_plan('demo-user-4',path)
        self.counters[10003]['bytes']=0
        with self.assertRaisesRegex(ValueError,'drifted'):m.migration_plan(USER,path)
    def test_cli_plan_exports_approval_hash_and_never_executes(self):
        plan=m.policy_plan(self.candidate());out=io.StringIO()
        with patch.object(m,'protected_bytes',return_value=(m.canonical(self.candidate()),{})),patch.object(m,'policy_plan',return_value=plan),patch.object(m,'execute',side_effect=AssertionError),contextlib.redirect_stdout(out):m.main(['policy','--candidate','/root/next.json'])
        saved=json.loads(out.getvalue());self.assertEqual(saved,{'plan':plan,'planSHA256':m.sha(m.canonical(plan))})
    def test_cli_execute_requires_exact_saved_approval_and_operation(self):
        plan=m.policy_plan(self.candidate());digest=m.sha(m.canonical(plan))
        saved={'plan':plan,'planSHA256':digest}
        with patch.object(m,'protected_bytes',return_value=(m.canonical(saved),{})),patch.object(m,'execute',return_value={'phase':'POLICY_UPDATED'}) as execute,contextlib.redirect_stdout(io.StringIO()):
            m.main(['policy','--execute','--plan','/root/plan.json','--approved-plan-sha256',digest]);execute.assert_called_once_with(plan,digest)
            with self.assertRaisesRegex(ValueError,'approval mismatch'):m.main(['policy','--execute','--plan','/root/plan.json','--approved-plan-sha256','f'*64])
            with self.assertRaisesRegex(ValueError,'operation mismatch'):m.main(['migrate','--execute','--plan','/root/plan.json','--approved-plan-sha256',digest])


class TreeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.root.chmod(0o700)
        self.attrs={};self.assignments=[]
        self.mount=patch.object(m,'nested_mounts');self.mount.start()
        self.attr=patch.object(m.q,'attribute',side_effect=self.attribute);self.attr.start()
    def tearDown(self):self.attr.stop();self.mount.stop();self.temp.cleanup()
    def attribute(self,fd,project_id=None,inherit=True):
        st=os.fstat(fd);key=(st.st_dev,st.st_ino);value=self.attrs.get(key,(0,False))
        if project_id is not None:
            value=(project_id,True if inherit else value[1]);self.attrs[key]=value;self.assignments.append(key)
        return value
    def scan(self):return m.tree_snapshot(self.root,os.getuid(),10003)
    def test_nonempty_scan_only_reads_and_hashes_names_and_metadata(self):
        (self.root/'file').write_bytes(b'original');before=(self.root/'file').stat();rows,summary=self.scan()
        self.assertEqual(summary['entries'],2);self.assertEqual(self.assignments,[]);self.assertEqual(rows[1]['path'],'file')
        self.assertEqual(m.identity(before),m.identity((self.root/'file').stat()));self.assertEqual((self.root/'file').read_bytes(),b'original')
    def test_internal_hardlinks_preserved_and_charged_once(self):
        (self.root/'one').write_bytes(b'data');os.link(self.root/'one',self.root/'two')
        rows,summary=self.scan();self.assertEqual(summary['internalHardlinkGroups'],1);self.assertEqual(summary['uniqueInodes'],2)
        evidence={};count=m.migrate_entries({'path':str(self.root),'projectId':10003},rows,evidence=evidence)
        after,_=self.scan();m.verify_tree(rows,after,10003,evidence)
        self.assertEqual(count,2);self.assertEqual(len(self.assignments),2);self.assertEqual((self.root/'one').stat().st_ino,(self.root/'two').stat().st_ino)
        self.assertEqual((self.root/'two').read_bytes(),b'data')
    def test_external_hardlink_blocks_without_deleting(self):
        (self.root/'one').write_bytes(b'data')
        with tempfile.TemporaryDirectory() as other:
            os.link(self.root/'one',Path(other)/'external')
            with self.assertRaisesRegex(ValueError,'External hardlink'):self.scan()
        self.assertEqual(self.assignments,[]);self.assertEqual((self.root/'one').read_bytes(),b'data')
    def test_symlink_is_not_followed(self):
        (self.root/'link').symlink_to('/etc')
        with self.assertRaises(OSError):self.scan()
        self.assertEqual(self.assignments,[])
    def test_special_file_is_rejected_without_blocking(self):
        os.mkfifo(self.root/'fifo')
        with self.assertRaisesRegex(ValueError,'Unsafe'):self.scan()
        self.assertEqual(self.assignments,[])
    def test_world_writable_and_wrong_owner_fail(self):
        (self.root/'file').write_bytes(b'x');(self.root/'file').chmod(0o666)
        with self.assertRaisesRegex(ValueError,'Unsafe'):self.scan()
        with self.assertRaisesRegex(ValueError,'service-private'):m.tree_snapshot(self.root,os.getuid()+1,10003)
    def test_unknown_project_id_fails(self):
        st=self.root.stat();self.attrs[(st.st_dev,st.st_ino)]=(10004,True)
        with self.assertRaisesRegex(ValueError,'another project'):self.scan()
    def test_per_inode_cas_detects_change_before_first_write(self):
        (self.root/'file').write_bytes(b'old');rows,_=self.scan();(self.root/'file').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'changed before'):m.migrate_entries({'path':str(self.root),'projectId':10003},rows,evidence={})
        self.assertEqual(self.assignments,[])
    def test_structural_change_after_migration_fails(self):
        (self.root/'file').write_bytes(b'old');rows,_=self.scan();evidence={};m.migrate_entries({'path':str(self.root),'projectId':10003},rows,evidence=evidence)
        (self.root/'file').write_bytes(b'changed');after,_=self.scan()
        with self.assertRaisesRegex(ValueError,'changed after'):m.verify_tree(rows,after,10003,evidence)
    def test_migration_final_check_does_not_blanket_ignore_ctime(self):
        (self.root/'file').write_bytes(b'old');rows,_=self.scan();evidence={};m.migrate_entries({'path':str(self.root),'projectId':10003},rows,evidence=evidence)
        after,_=self.scan();after[1]['identity'][-1]+=1
        with self.assertRaisesRegex(ValueError,'changed after'):m.verify_tree(rows,after,10003,evidence)
    def test_directory_inheritance_installed_children_first_parent_last(self):
        (self.root/'child').mkdir();(self.root/'child'/'file').write_bytes(b'x');rows,_=self.scan()
        evidence={};m.migrate_entries({'path':str(self.root),'projectId':10003},rows,evidence=evidence)
        root=self.root.stat();self.assertEqual(self.assignments[-1],(root.st_dev,root.st_ino))
        after,_=self.scan();m.verify_tree(rows,after,10003,evidence)
    def test_entry_limit_fail_closed(self):
        (self.root/'file').write_bytes(b'x')
        with patch.object(m,'MAX_ENTRIES',1),self.assertRaisesRegex(ValueError,'entry limit'):self.scan()
    def test_same_device_nested_mount_is_rejected(self):
        self.mount.stop()
        row='1 0 1:1 / '+str(self.root/'nested')+' rw - ext4 /dev/a rw\n'
        with patch.object(Path,'read_text',return_value=row),self.assertRaisesRegex(ValueError,'Nested mount'):m.nested_mounts(self.root)
        self.mount.start()


class OfflineGateTests(unittest.TestCase):
    def gate(self,uid,exe,group,start='42'):
        with tempfile.TemporaryDirectory() as tmp:
            proc=Path(tmp).resolve()/'123';proc.mkdir()
            (proc/'status').write_text('Uid:\t'+ '\t'.join([str(uid)]*4)+'\n')
            (proc/'stat').write_text('123 (safe name) '+' '.join(['S']+['0']*18+[start]+['0']*4))
            (proc/'cgroup').write_text('0::'+group+'\n')
            real=Path
            def path(value):
                if str(value)=='/proc':return SimpleNamespace(iterdir=lambda:[proc])
                if str(value)==exe:return SimpleNamespace(stat=lambda:SimpleNamespace(st_uid=0,st_mode=stat.S_IFREG|0o755))
                return real(value)
            with patch.object(m,'Path',side_effect=path),patch.object(m.os,'geteuid',return_value=0),patch.object(m.pwd,'getpwuid',return_value=SimpleNamespace(pw_name='gpuq')),patch.object(m,'protected_bytes',side_effect=lambda path,maximum=0:(b'gpuq:100000:65536\n',{'sha256':'a'*64})),patch.object(m.os,'readlink',return_value=exe),patch.object(m.q,'check_guard',return_value={'guarded':True}):
                return m.offline_gate(policy())
    def test_fixed_idle_user_manager_allowed(self):
        got=self.gate(1000,'/usr/lib/systemd/systemd','/user.slice/user-1000.slice/user@1000.service/init.scope')
        self.assertEqual(got['idleProcesses'][0]['pid'],123)
    def test_same_executable_outside_fixed_unit_is_not_idle(self):
        with self.assertRaisesRegex(ValueError,'Live service'):self.gate(1000,'/usr/lib/systemd/systemd','/untrusted.scope')
    def test_regular_service_payload_blocks(self):
        with self.assertRaisesRegex(ValueError,'Live service'):self.gate(1000,'/usr/bin/python3','/user.slice/job.scope')
    def test_subuid_container_payload_blocks(self):
        with self.assertRaisesRegex(ValueError,'Live service'):self.gate(100010,'/usr/bin/python3','/user.slice/container.scope')
    def test_unrelated_account_is_not_read_as_user_data(self):
        got=self.gate(2000,'/usr/bin/python3','/other.scope');self.assertEqual(got['idleProcesses'],[])


if __name__=='__main__':unittest.main()
