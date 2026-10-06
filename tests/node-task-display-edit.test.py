"""Fixed native identity + real SQLite CAS, without GPU or production calls."""
from copy import deepcopy
import importlib.util
from pathlib import Path
import unittest
import sys

spec=importlib.util.spec_from_file_location('display_edit_fixture',Path(__file__).with_name('node-task-display.test.py'))
F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F)

class Edit(unittest.TestCase):
    setUp=F.NodeDisplay.setUp
    gpu=F.NodeDisplay.gpu
    snapshot=F.NodeDisplay.snapshot
    submit=F.NodeDisplay.submit
    running=F.NodeDisplay.running
    def context(self):
        result=self.node.process('sync',{'job':self.job,'metadata':self.meta})
        return {'userId':self.job['userId'],'hostAdmin':False,'nodeJobId':result['nodeJobId'],'job':self.job}
    def read(self,ctx):return self.node.process('tasks.display.get',ctx)
    def setting(self,ctx,current,**changes):
        return {**ctx,'name':'中文｜更新标签','description':'更准确的描述','revision':current['revision'],**changes}
    def test_real_owner_edit_preserves_spec_and_reconcile_and_fixed_native_id(self):
        ctx=self.context();before=self.store.get_job(ctx['nodeJobId']);original=deepcopy(self.job)
        current=self.read(ctx);self.assertTrue(current['available']);self.assertEqual(current['name'],self.job['name'])
        result=self.node.process('tasks.display.set',self.setting(ctx,current))
        self.assertEqual(result['nodeJobId'],ctx['nodeJobId']);self.assertEqual(result['name'],'中文｜更新标签')
        after=self.store.get_job(ctx['nodeJobId'])
        self.assertEqual({k:v for k,v in after.items() if k!='display_metadata'},{k:v for k,v in before.items() if k!='display_metadata'})
        self.assertEqual(self.job,original)
        self.assertEqual(self.node.process('sync',{'job':self.job,'metadata':self.meta})['displaySync']['state'],'PRESERVED')
    def test_other_account_and_spec_forgery_and_unlinked_member_are_rejected(self):
        ctx=self.context()
        for bad in ({**ctx,'userId':'demo-user-9'}, {k:v for k,v in ctx.items() if k!='job'},
                    {**ctx,'job':{**self.job,'argv':['other']}}):
            with self.assertRaises((ValueError,FileNotFoundError)):self.read(bad)
        native=self.node.gpu('submit','--owner','alice','--name','native-train','-g','1','--',sys.executable,'-c','pass')
        result=self.read({'userId':'builtin-admin','hostAdmin':True,'nodeJobId':native['job_id']})
        self.assertEqual(result['name'],'native-train');self.assertTrue(result['available'])
    def test_old_revision_and_changed_binding_do_not_overwrite(self):
        ctx=self.context();current=self.read(ctx)
        self.node.process('tasks.display.set',self.setting(ctx,current))
        with self.assertRaisesRegex(ValueError,'revision'):self.node.process('tasks.display.set',self.setting(ctx,current,name='过期'))
        self.store._get_connection().execute("UPDATE jobs SET name='another-original' WHERE id=?",(ctx['nodeJobId'],))
        with self.assertRaisesRegex(ValueError,'binding'):self.read(ctx)
    def test_lost_ack_is_recovered_by_original_get_without_replaying_set(self):
        ctx=self.context();current=self.read(ctx);real=self.node.gpu;writes=0
        def lost(*argv):
            nonlocal writes
            result=real(*argv)
            if argv[0]=='set-display':writes+=1;raise ValueError('lost ACK')
            return result
        self.node.gpu=lost
        with self.assertRaisesRegex(ValueError,'lost ACK'):self.node.process('tasks.display.set',self.setting(ctx,current))
        self.assertEqual(self.read(ctx)['name'],'中文｜更新标签');self.assertEqual(writes,1)
    def test_daemon_without_cas_is_readable_but_never_writes(self):
        ctx=self.context();real=self.node.gpu
        def legacy(*argv):
            result=real(*argv)
            if argv[0]=='status':result['daemon']['capabilities'].remove('job-display-cas-v1')
            return result
        self.node.gpu=legacy;current=self.read(ctx);self.assertFalse(current['available'])
        with self.assertRaisesRegex(ValueError,'capability'):self.node.process('tasks.display.set',self.setting(ctx,current))
        self.assertEqual(self.store.get_job(ctx['nodeJobId'])['display_metadata'],self.meta)
    def test_symlink_spec_and_invalid_extra_fields_reject_without_write(self):
        ctx=self.context();path=self.node.ROOT/'jobs'/(self.job['id']+'.json');original=path.with_suffix('.original');path.rename(original);path.symlink_to(original)
        with self.assertRaises(OSError):self.read(ctx)
        path.unlink();original.rename(path)
        for extra in ({'owner':'other'},{'argv':['other']},{'expectedName':'raw'}):
            with self.assertRaisesRegex(ValueError,'request'):self.read({**ctx,**extra})

if __name__=='__main__':unittest.main()
