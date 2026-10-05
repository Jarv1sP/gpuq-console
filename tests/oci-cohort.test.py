import copy,hashlib,importlib.util,json,os,stat,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parents[1]/'deploy'
def load(name):
    spec=importlib.util.spec_from_file_location('test_'+name,HERE/(name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
c=load('oci-cohort');o=load('personal-oci')
OWNER='demo-user-3';SHA='a'*64
def value():
    return {'root':'/data/console','unchanged':{'secret':'not-output','newKeys':[1,2]},'storageQuota':{'enabled':False},'personalOci':{'enabled':True,'owners':[OWNER],'autoOwners':True,'baseImage':'docker.io/library/ubuntu@sha256:'+SHA,'podmanSHA256':SHA,'runtimeSHA256':SHA,'cdiSHA256':SHA}}
class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'node-config.json';self.path.parent.chmod(0o700);self.write(value())
    def tearDown(self):self.tmp.cleanup()
    def write(self,v):self.path.write_text(json.dumps(v));self.path.chmod(0o600)
    def sync(self,owners=None,revision=1):return c.sync(self.path,{'hostAdmin':True,'owners':[OWNER] if owners is None else owners,'revision':revision})
    def test_merge_preserves_all_other_keys_metadata_and_no_task_actions(self):
        before=json.loads(self.path.read_text());meta=self.path.stat();out=self.sync(['demo-user-4'])
        after=json.loads(self.path.read_text());expected=copy.deepcopy(before);expected['personalOci'].update(owners=['demo-user-4'],autoOwnersRevision=1)
        self.assertEqual(after,expected);self.assertEqual(out['ownersSHA256'],hashlib.sha256(b'["demo-user-4"]').hexdigest());self.assertEqual(stat.S_IMODE(self.path.stat().st_mode),0o600);self.assertEqual((self.path.stat().st_uid,self.path.stat().st_gid),(meta.st_uid,meta.st_gid))
    def test_empty_membership_rejects_every_owner_before_creation(self):
        self.sync([]);cfg=json.loads(self.path.read_text())
        with patch.object(o.Path,'mkdir',side_effect=AssertionError):
            for owner in (OWNER,'builtin-admin','demo-user-4'):
                with self.assertRaisesRegex(ValueError,'Authenticated owner'):o.PersonalOCI(cfg,owner)
    def test_stale_and_conflicting_revision_cannot_restore_revoked_owner(self):
        self.sync([],revision=2);before=self.path.read_bytes()
        for rev in (1,2):
            with self.assertRaises(ValueError):self.sync([OWNER],revision=rev)
            self.assertEqual(self.path.read_bytes(),before)
        self.assertFalse(self.sync([],revision=2)['changed'])
    def test_default_off_manual_cohort_and_unscoped_remain_unchanged(self):
        for change in ({'autoOwners':False},{'enabled':False},{'owners':None}):
            cfg=value();cfg['personalOci'].update(change)
            if change.get('owners','sentinel') is None:del cfg['personalOci']['owners']
            self.write(cfg);before=self.path.read_bytes()
            with self.assertRaises(ValueError):self.sync()
            self.assertEqual(self.path.read_bytes(),before)
        cfg=value();del cfg['personalOci']['owners'];del cfg['personalOci']['autoOwners']
        with self.assertRaisesRegex(ValueError,'hard quotas'):o.policy(cfg,OWNER)
        cfg=value();cfg['personalOci'].pop('autoOwners');cfg['personalOci']['owners']=[]
        with self.assertRaisesRegex(ValueError,'owner cohort'):o.policy(cfg,OWNER)
    def test_invalid_internal_fields_owner_order_revision_and_public_flag_refused(self):
        base={'hostAdmin':True,'owners':[OWNER],'revision':1}
        for args in ({**base,'hostAdmin':False},{**base,'userId':OWNER},{**base,'owners':['all']},{**base,'owners':[OWNER,OWNER]},{**base,'owners':['demo-user-4',OWNER]},{**base,'revision':True},{**base,'revision':0},{**base,'revision':2**53}):
            with self.subTest(args=args),self.assertRaises(ValueError):c.sync(self.path,args)
    def test_symlink_hardlink_and_unsafe_mode_refused(self):
        for kind in ('symlink','hardlink','mode'):
            self.write(value());target=self.path.with_name('other')
            if target.exists():target.unlink()
            if kind=='symlink':self.path.rename(target);self.path.symlink_to(target)
            elif kind=='hardlink':os.link(self.path,target)
            else:self.path.chmod(0o644)
            with self.subTest(kind=kind),self.assertRaises((ValueError,OSError)):self.sync()
            if self.path.is_symlink():self.path.unlink();target.rename(self.path)
            if target.exists():target.unlink()
    def test_concurrent_config_replacement_cas_refused_and_temp_cleaned(self):
        real=os.stat;changed={'done':False}
        def race(path,*args,**kwargs):
            if path==self.path.name and not changed['done']:
                changed['done']=True;tmp=self.path.with_name('external');tmp.write_bytes(self.path.read_bytes());tmp.chmod(0o600);tmp.replace(self.path)
            return real(path,*args,**kwargs)
        with patch.object(c.os,'stat',side_effect=race),self.assertRaisesRegex(ValueError,'before CAS'):self.sync()
        self.assertEqual(json.loads(self.path.read_text()),value());self.assertFalse(list(self.path.parent.glob('*.oci-cohort-*')))
if __name__=='__main__':unittest.main()
