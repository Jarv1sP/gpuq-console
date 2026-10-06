"""Real personal-upload bytes remain charged throughout recoverable isolation."""
import importlib.util
from pathlib import Path
import unittest
import uuid

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
F=load('quota_upload_fixture',ROOT/'tests/dataset-upload.test.py')
R=load('quota_retention',ROOT/'deploy/dataset-retirement.py')

class RetirementQuota(unittest.TestCase):
    setUp=F.PersonalUploads.setUp
    tearDown=F.PersonalUploads.tearDown
    call=F.PersonalUploads.call
    admit=F.PersonalUploads.admit
    seal=F.PersonalUploads.seal
    fill=F.PersonalUploads.fill

    def publish(self):
        result,_,files=self.seal();key=result['uploadId'];self.fill(key,files)
        self.call('commit',uploadId=key);self.assertEqual(self.u.worker(self.user,key,'commit'),0)
        return self.u.load(self.user,key)

    def test_fenced_isolated_and_restoring_bytes_are_never_refunded_as_missing_registration(self):
        session=self.publish();actor=F.D.Principal(self.user);clock=[1000.]
        # The quota fixture owns its fake clock; it must not consult the real
        # host's NTP state. NTP refusal is covered by dataset-retirement tests.
        retention=R.DatasetRetirement(self.cache,'test-node',clock=lambda:clock[0],clock_synchronized=lambda:True);key=str(uuid.uuid4())
        snap=retention.inspect(actor,session['dataset'],session['version'])
        retention.fence(actor,session['dataset'],session['version'],key,snap)
        with self.cache._locked():self.assertEqual(self.u.retire_unregistered(session),session)
        retention.isolate(actor,session['dataset'],session['version'],key,snap)
        before=self.u.load(self.user,session['uploadId'])
        self.u.limits['maxUserBytes']=session['reserveBytes']
        for now in (1000.,1000.+7*86400-1):
            clock[0]=now
            with self.cache._locked():self.assertEqual(self.u.retire_unregistered(session),session)
            self.assertEqual(self.u.load(self.user,session['uploadId']),before)
            with self.assertRaisesRegex(ValueError,'quota'):self.admit(name='another')
        restored=retention.restore(F.D.Principal('builtin-admin',True),key)
        self.assertEqual(restored['state'],'RESTORED')
        with self.cache._locked():self.assertEqual(self.u.retire_unregistered(session),session)
        self.assertEqual(self.u.load(self.user,session['uploadId']),before)
        with self.assertRaisesRegex(ValueError,'quota'):self.admit(name='another')

    def test_only_exact_purged_registration_allows_reservation_reclamation(self):
        session=self.publish();actor=F.D.Principal(self.user);clock=[1000.]
        retention=R.DatasetRetirement(self.cache,'test-node',clock=lambda:clock[0],clock_synchronized=lambda:True);key=str(uuid.uuid4())
        snap=retention.inspect(actor,session['dataset'],session['version']);retention.isolate(actor,session['dataset'],session['version'],key,snap)
        clock[0]+=7*86400+1;retention.purge(F.D.Principal('builtin-admin',True),key)
        with self.cache._locked(),self.assertRaisesRegex(ValueError,'generation'):
            self.u.retire_unregistered({**session,'registrationIdentity':[0]*5})
        self.assertEqual(self.u.load(self.user,session['uploadId'])['state'],'READY')
        with self.cache._locked():result=self.u.retire_unregistered(session)
        self.assertEqual(result['state'],'DISCARDED')
        self.u.limits['maxUserBytes']=session['reserveBytes']
        self.assertEqual(self.admit(name='another')[0]['state'],'RECEIVING_MANIFEST')

if __name__=='__main__':unittest.main()
