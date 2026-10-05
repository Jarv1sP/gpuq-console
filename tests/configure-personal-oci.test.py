import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import Mock,patch

spec=importlib.util.spec_from_file_location('oci_setup_test',Path(__file__).resolve().parents[1]/'deploy/configure-personal-oci.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
BASE='docker.io/library/ubuntu@sha256:'+'a'*64
RAW=json.dumps({'kind':'nvidia.com/gpu','devices':[{'name':'GPU-12345678-1111-2222-3333-123456789012'}]}).encode()


class Setup(unittest.TestCase):
    def plan(self,version='podman version 4.1.1'):
        with patch.object(c.Path,'read_bytes',return_value=b'binary'),patch.object(c.o,'protected_file'),patch.object(c.subprocess,'run',return_value=Mock(stdout=version)):
            return c.plan(BASE,RAW)

    def test_dry_run_keeps_every_feature_and_service_off(self):
        value=self.plan()
        self.assertEqual(value['phase'],'DRY_RUN')
        for key in ('featuresEnabled','packagesInstalled','servicesStarted','mountsChanged'):self.assertFalse(value[key])
        self.assertEqual(len(value['planSHA256']),64)

    def test_distro_34_is_not_silently_accepted_for_cdi(self):
        with self.assertRaisesRegex(ValueError,'4.1'):self.plan('podman version 3.4.4')

    def test_dependency_digest_is_part_of_plan(self):
        one=self.plan()
        with patch.object(c.Path,'read_bytes',return_value=b'changed'),patch.object(c.o,'protected_file'),patch.object(c.subprocess,'run',return_value=Mock(stdout='podman version 4.1.1')):
            two=c.plan(BASE,RAW)
        self.assertNotEqual(one['planSHA256'],two['planSHA256'])

    def test_exact_base_policy_is_private_and_part_of_approved_plan(self):
        value = self.plan()
        raw = c.o.signature_policy_raw(BASE)
        self.assertEqual(value['signaturePolicySHA256'], c.sha(raw))
        self.assertEqual(json.loads(raw), {'default': [{'type': 'reject'}],
                         'transports': {'docker': {BASE: [{'type': 'insecureAcceptAnything'}]}}})
        self.assertTrue(raw.endswith(b'\n'))
        self.assertEqual(str(c.o.SIGNATURE_POLICY), '/etc/gpuq-console/personal-oci-policy.json')
        with patch.object(c.Path,'read_bytes',return_value=b'binary'), \
             patch.object(c.o,'protected_file'), \
             patch.object(c.subprocess,'run',return_value=Mock(stdout='podman version 4.1.1')):
            changed = c.plan('docker.io/library/ubuntu@sha256:'+'b'*64, RAW)
        self.assertNotEqual(value['signaturePolicySHA256'], changed['signaturePolicySHA256'])
        self.assertNotEqual(value['planSHA256'], changed['planSHA256'])

    def test_tag_or_missing_devices_rejected_before_binary_reads(self):
        with self.assertRaises(ValueError):c.plan('ubuntu:latest',RAW)
        with self.assertRaises(ValueError):c.plan(BASE,b'{"kind":"nvidia.com/gpu","devices":[]}')

    def test_execute_requires_root(self):
        with patch.object(c.os,'geteuid',return_value=1000),self.assertRaisesRegex(ValueError,'Administrator'):
            c.execute(BASE,RAW,'a'*64)

    def test_execute_installs_only_fixed_readonly_policy_not_system_policy(self):
        planned = self.plan()
        with patch.object(c.os, 'geteuid', return_value=0), \
             patch.object(c.Path, 'is_file', return_value=True), \
             patch.object(c.Path, 'exists', return_value=False), \
             patch.object(c.Path, 'is_symlink', return_value=False), \
             patch.object(c, 'plan', return_value=planned), \
             patch.object(c.os, 'listdir', return_value=[]), \
             patch.object(c.q, 'protected_directory'), patch.object(c.q, 'put_new') as put:
            result = c.execute(BASE, RAW, planned['planSHA256'])
        puts = {call.args[0]: call.args[1:] for call in put.call_args_list}
        self.assertEqual(puts[c.o.SIGNATURE_POLICY], (c.o.signature_policy_raw(BASE), 0o444))
        self.assertNotIn(Path('/etc/containers/policy.json'), puts)
        self.assertFalse(result['featuresEnabled'])
        self.assertEqual(result['phase'], 'OCI_CONTROLS_INSTALLED_FEATURE_DISABLED')


if __name__=='__main__':unittest.main()
