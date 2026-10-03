"""Local tests of the opt-in LAN acceptance runner against the actual daemon."""
import importlib.util
import json
from pathlib import Path
import shutil
import unittest
import uuid


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


HERE = Path(__file__).resolve().parent
F = load('storage_lan_daemon_fixture', HERE / 'storage-authority-daemon.test.py')
R = load('storage_lan_acceptance_runner', HERE / 'storage-lan-smoke.py')


class StorageLANRunner(unittest.TestCase):
    def setUp(self):
        self.f = F.AuthorityDaemon()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.f.config.update(machine=R.SOURCE, storageAuthority={'enabled': True})
        self.f.write_config()
        self.f.node.CONFIG = self.f.config
        self.run = str(uuid.uuid4())
        self.grant = self.f.root / 'private' / 'grant.json'

    def tearDown(self):
        self.f.tearDown()

    def target(self):
        runtime = self.f.root / 'target-runtime'
        shutil.copytree(self.f.runtime, runtime)
        state = self.f.root / 'target-state'
        state.mkdir(mode=0o700)
        config = dict(root=str(state), machine=R.TARGET,
                      datasets=dict(root=str(self.f.root / 'hot'), mountPoint=str(self.f.root), sources={}, reserveBytes=0),
                      transferPeers={R.SOURCE: self.f.peer}, storageAuthorities={'hdd': {'machine': R.SOURCE}})
        (runtime / 'node-config.json').write_text(json.dumps(config))
        return R.load_node(runtime)

    def check(self, node):
        # Test-only loopback adapter; the CLI cannot bypass physical-LAN checks.
        return R.target_check(node, self.run, self.grant, 'hdd',
                              _route=lambda address: dict(address=address, interface='fixture-loopback', direct=True))

    def test_full_two_mib_runner_retains_only_approved_source_and_target_metadata(self):
        self.f.start()
        old_data = (self.f.cache._paths('shared', self.f.version)['ready'] / 'data' / 'data.bin').read_bytes()
        source = R.source_seal(self.f.node, self.run, self.grant)
        self.assertEqual(source['sourceBytes'], 2 * 1024**2)
        self.assertEqual(source['owners'], ['builtin-admin'])
        secret = json.loads(self.grant.read_text())['token']
        self.assertNotIn(secret, json.dumps(source))
        self.assertEqual(self.grant.stat().st_mode & 0o777, 0o600)
        self.assertEqual(R.source_seal(self.f.node, self.run, self.grant), source)
        node = self.target()
        result = self.check(node)
        self.assertEqual(result['state'], 'PASS')
        self.assertTrue(result['targetPayloadRemoved'])
        self.assertTrue(result['targetRecoveryMetadataRetained'])
        self.assertNotIn(secret, json.dumps(result))
        self.assertFalse(result['gcEnabled'])
        self.assertEqual(result['denied'], ['certificate', 'token', 'reference'])
        self.assertEqual(self.check(node)['state'], 'PASS')
        module, cache = node.dataset_cache()
        self.assertEqual(cache._leases(result['dataset'], result['version']), [])
        self.assertEqual(self.f.cache.status(self.f.admin, source['dataset'], source['version'])['state'], 'READY')
        self.assertEqual((self.f.cache._paths('shared', self.f.version)['ready'] / 'data' / 'data.bin').read_bytes(), old_data)

    def test_runner_refuses_offline_peer_wrong_machine_gc_on_and_non_lan_routes(self):
        name, _, _ = R.sample(self.run)
        with self.assertRaisesRegex(ValueError, 'live'):
            R.source_seal(self.f.node, self.run, self.grant)
        self.assertFalse(self.f.cache._paths(name)['.registry'].exists())
        self.f.node.CONFIG['machine'] = R.TARGET
        with self.assertRaisesRegex(ValueError, 'identity'):
            R.source_seal(self.f.node, self.run, self.grant)
        self.f.node.CONFIG['machine'] = R.SOURCE
        self.f.node.CONFIG['storageTier'] = {'enabled': True, 'budgetBytes': 1}
        with self.assertRaisesRegex(ValueError, 'disabled'):
            R.source_seal(self.f.node, self.run, self.grant)
        for address in ('127.0.0.1', '100.64.0.9', '8.8.8.8'):
            with self.assertRaisesRegex(ValueError, 'physical'):
                R.check_physical_lan(address)

    def test_target_refuses_a_grant_for_any_other_dataset_without_touching_payload(self):
        self.f.start()
        R.source_seal(self.f.node, self.run, self.grant)
        node = self.target()
        grant = json.loads(self.grant.read_text())
        grant['dataset'] = 'shared'
        self.f.authority.D._write_json(self.grant, grant)
        with self.assertRaisesRegex(ValueError, 'exact approved'):
            self.check(node)
        _, cache = node.dataset_cache()
        name, _, _ = R.sample(self.run)
        self.assertFalse(cache._paths(name)['.registry'].exists())


if __name__ == '__main__':
    unittest.main()
