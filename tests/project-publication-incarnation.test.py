"""Issue #65: a replacement project must not inherit an owner/slug receipt."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid

source = Path(__file__).with_name('node-projects.test.py')
spec = importlib.util.spec_from_file_location('publication_incarnation_fixture', source)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class PublicationIncarnationTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture.NodeProjects()
        self.f.setUp()
        self.addCleanup(self.f.tearDown)
        self.ops, self.n, self.args = self.f.ops, self.f.n, self.f.args
        paths = self.ops.store.dev_paths(*self.ops.identity(self.args))
        (paths['env'] / 'bin').mkdir()
        (paths['env'] / 'bin/python').write_text('synthetic interpreter; never executed')
        (paths['env'] / 'pyvenv.cfg').write_text('home = synthetic\n')

    def status(self):
        with patch.object(self.ops, 'active', return_value=False):
            return self.ops.status(self.args)

    def publish(self, key):
        with patch.object(self.n, 'run', return_value=''):
            return self.f.call('projects.publish', key=key)

    def replace_project(self):
        path, meta = self.ops.store._project(*self.ops.identity(self.args))
        path.rename(path.with_name('old-incarnation'))
        # Reset within the same second, just as owner/slug names may be reused.
        with patch('time.time', return_value=meta['createdAt']):
            self.ops.store.create(*self.ops.identity(self.args))

    def test_same_owner_slug_and_second_do_not_inherit_a_failed_publication(self):
        key = str(uuid.uuid4())
        self.publish(key)
        old = self.ops.receipt(self.args)
        self.n.atomic_json(self.ops.receipt_path(self.args),
                           {**old, 'state': 'FAILED', 'error': 'old project root-owned file'})
        original = self.ops.receipt_path(self.args).read_bytes()
        self.replace_project()
        status = self.status()
        self.assertEqual(status['state'], 'DRAFT')
        self.assertNotIn('publication', status)
        self.assertNotIn('error', status)
        self.assertEqual(self.ops.receipt_path(self.args).read_bytes(), original)
        with patch.object(self.n, 'run', side_effect=AssertionError('No old-key dispatch')):
            with self.assertRaisesRegex(ValueError, 'earlier project'):
                self.f.call('projects.publish', key=key)

    def test_a_delayed_old_worker_cannot_publish_the_replacement_project(self):
        started = self.publish(str(uuid.uuid4()))
        old = self.ops.receipt(self.args)
        self.replace_project()
        original = self.ops.receipt_path(self.args).read_bytes()
        with patch.object(self.ops.store, 'publish', side_effect=AssertionError('No stale publish')):
            with self.assertRaises(ValueError):
                self.ops.worker(started['operationId'], old['publicationId'], old.get('projectGeneration'))
        self.assertEqual(self.ops.receipt_path(self.args).read_bytes(), original)

    def test_new_receipts_bind_a_persistent_project_uuid_as_well_as_generation(self):
        self.publish(str(uuid.uuid4()))
        old = self.ops.receipt(self.args)
        self.assertIsInstance(old.get('projectUUID'), str,
                              'New receipts need the durable project identity, not only owner and slug')
        self.assertEqual(str(uuid.UUID(old['projectUUID'])), old['projectUUID'])
        self.assertRegex(old['projectGeneration'], r'^[a-f0-9]{64}$')
        self.replace_project()
        self.publish(str(uuid.uuid4()))
        current = self.ops.receipt(self.args)
        self.assertNotEqual(old['projectUUID'], current['projectUUID'])
        self.assertNotEqual(old['projectGeneration'], current['projectGeneration'])
        archived = self.ops.historical_receipt(self.args, old['publicationId'])
        self.assertEqual(archived, old, 'The old UUID and evidence remain intact')

    def test_unbound_legacy_failure_is_unknown_and_cannot_be_claimed_as_current(self):
        self.replace_project()
        legacy = {**self.args, 'publicationId': str(uuid.uuid4()),
                  'state': 'FAILED', 'error': 'failure from an unidentified old project'}
        self.n.atomic_json(self.ops.receipt_path(self.args), legacy)
        original = self.ops.receipt_path(self.args).read_bytes()
        status = self.status()
        self.assertEqual(status['state'], 'UNKNOWN', 'An unbound receipt is not this project\'s failure')
        self.assertNotEqual(status.get('publication', {}).get('state'), 'FAILED')
        self.assertNotEqual(status.get('error'), legacy['error'])
        with patch.object(self.n, 'run', side_effect=AssertionError('Unbound history remains fenced')):
            with self.assertRaises(ValueError):
                self.f.call('projects.publish', key=str(uuid.uuid4()))
        self.assertEqual(self.ops.receipt_path(self.args).read_bytes(), original)

    def test_uuid_mismatch_is_rejected_even_if_the_local_generation_matches(self):
        started = self.publish(str(uuid.uuid4()))
        old = self.ops.receipt(self.args)
        path, meta = self.ops.store._project(*self.ops.identity(self.args))
        self.n.atomic_json(path / 'project.json', {**meta, 'projectUUID': str(uuid.uuid4())})
        self.assertEqual(self.ops.store.generation(*self.ops.identity(self.args)), old['projectGeneration'])
        self.assertEqual(self.status()['state'], 'DRAFT')
        self.assertNotIn('publication', self.status())
        original = self.ops.receipt_path(self.args).read_bytes()
        with patch.object(self.ops.store, 'publish', side_effect=AssertionError('No UUID-crossing worker')):
            with self.assertRaisesRegex(ValueError, 'earlier project'):
                self.ops.worker(started['operationId'], old['publicationId'], old['projectGeneration'])
        with self.assertRaisesRegex(ValueError, 'not overwritten'):
            self.ops.write_publication_receipt(old, {**old, 'state': 'FAILED'})
        self.assertEqual(self.ops.receipt_path(self.args).read_bytes(), original)

    def test_old_project_metadata_migrates_only_at_explicit_publish(self):
        path, meta = self.ops.store._project(*self.ops.identity(self.args))
        self.n.atomic_json(path / 'project.json', {key:value for key,value in meta.items() if key != 'projectUUID'})
        original = (path / 'project.json').read_bytes()
        self.assertEqual(self.status()['state'], 'DRAFT')
        self.assertIsNone(self.ops.store.project_uuid(*self.ops.identity(self.args)))
        self.assertEqual((path / 'project.json').read_bytes(), original, 'Status does not modify project metadata')
        generation = self.ops.store.generation(*self.ops.identity(self.args))
        self.publish(str(uuid.uuid4()))
        receipt = self.ops.receipt(self.args)
        self.assertEqual(self.ops.store.project_uuid(*self.ops.identity(self.args)), receipt['projectUUID'])
        self.assertEqual(self.ops.store.generation(*self.ops.identity(self.args)), generation)
        original = (path / 'project.json').read_bytes()
        self.status()
        self.assertEqual((path / 'project.json').read_bytes(), original)

    def test_existing_generation_only_receipt_still_identifies_the_same_project(self):
        self.publish(str(uuid.uuid4()))
        receipt = self.ops.receipt(self.args)
        receipt.pop('projectUUID')
        receipt.update(state='FAILED', error='this incarnation failed')
        self.n.atomic_json(self.ops.receipt_path(self.args), receipt)
        original = self.ops.receipt_path(self.args).read_bytes()
        status = self.status()
        self.assertEqual(status['state'], 'FAILED')
        self.assertEqual(status['error'], receipt['error'])
        self.assertEqual(self.ops.receipt_path(self.args).read_bytes(), original)
        self.replace_project()
        self.assertEqual(self.status()['state'], 'DRAFT')
        self.assertEqual(self.ops.receipt_path(self.args).read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
