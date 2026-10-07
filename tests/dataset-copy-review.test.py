"""Independent local safety regressions for exclusively locked batched copying."""
import contextlib
import importlib.util
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from dataset_retention_helpers import protected_original


SPEC = importlib.util.spec_from_file_location(
    "dataset_copy_review", Path(__file__).resolve().parents[1] / "deploy" / "dataset-cache.py")
D = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D)
ADMIN, OWNER, OTHER = D.Principal("admin", True), D.Principal("owner"), D.Principal("other")


class DatasetCopyReview(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.source = self.base / "source"
        self.source.mkdir()
        (self.source / "sample.bin").write_bytes(b"abcdefghijklmnopqrstuvwx")
        self.cache = D.DatasetCache(self.base / "cache", sources={"source": self.source},
                                    reserve_bytes=1024, lock_timeout=0.05)
        self.version = self.cache.register_source(ADMIN, "sample", "source", [OWNER.user_id])["version"]
        self.paths = self.cache._paths("sample", self.version)

    def tearDown(self):
        self.assertEqual((self.source / "sample.bin").read_bytes(), b"abcdefghijklmnopqrstuvwx")
        for root, _dirs, files in os.walk(self.base):
            os.chmod(root, 0o700)
            for name in files:
                os.chmod(Path(root) / name, 0o600)
        self.temp.cleanup()

    def test_owner_revocation_while_waiting_for_version_lock_invalidates_snapshot(self):
        lock = self.cache._lock_file
        changes = []

        @contextlib.contextmanager
        def revoke(name):
            if name.startswith(".locks/") and not changes:
                changes.append(True)
                self.cache.set_owners(ADMIN, "sample", [OTHER.user_id])
            with lock(name):
                yield

        with patch.object(self.cache, "_lock_file", side_effect=revoke):
            with self.assertRaises(PermissionError):
                self.cache.materialize(OWNER, "sample", self.version)
        self.assertEqual(len(changes), 1)
        self.assertFalse(self.paths[".staging"].exists())
        self.assertFalse(self.paths["ready"].exists())

    def test_registry_replacement_while_waiting_for_version_lock_invalidates_snapshot(self):
        lock = self.cache._lock_file
        changes = []

        @contextlib.contextmanager
        def replace(name):
            if name.startswith(".locks/") and not changes:
                changes.append(True)
                self.cache.attach_source(ADMIN, "sample", self.version, "source")
            with lock(name):
                yield

        with patch.object(self.cache, "_lock_file", side_effect=replace):
            with self.assertRaisesRegex(D.CacheError, "registration changed"):
                self.cache.materialize(OWNER, "sample", self.version)
        self.assertEqual(len(changes), 1)
        self.assertFalse(self.paths[".staging"].exists())
        self.assertFalse(self.paths["ready"].exists())

    def test_revocation_during_readonly_conversion_never_publishes_and_remains_resumable(self):
        modes = D._modes

        def revoke(path, readonly, *, bulk_durability=False):
            self.assertEqual(bulk_durability, readonly)
            modes(path, readonly, bulk_durability=bulk_durability)
            if readonly:
                self.cache.set_owners(ADMIN, "sample", [OTHER.user_id])

        with patch.object(D, "_modes", side_effect=revoke):
            with self.assertRaises(PermissionError):
                self.cache.materialize(OWNER, "sample", self.version)
        self.assertFalse(self.paths["ready"].exists())
        self.assertEqual(self.paths[".staging"].stat().st_mode & 0o777, 0o700)
        self.assertEqual(D._read_json(self.paths[".staging"] / "TRANSFER.json")["remainingBytes"], 0)
        self.assertEqual(self.cache.materialize(ADMIN, "sample", self.version)["state"], "READY")
        self.assertTrue(self.cache.verify(OTHER, "sample", self.version)["verified"])

    def test_long_materialize_excludes_unregister_without_holding_the_global_lock(self):
        entered, resume = threading.Event(), threading.Event()
        errors = []
        put = self.cache._put_chunk_data

        def blocked(*args, **kwargs):
            entered.set()
            if not resume.wait(3):
                raise AssertionError("copy fixture did not resume")
            return put(*args, **kwargs)

        def worker():
            try:
                self.cache.materialize(OWNER, "sample", self.version)
            except BaseException as exc:
                errors.append(exc)

        other = D.DatasetCache(self.cache.root, sources={"source": self.source}, reserve_bytes=1024, lock_timeout=0.05)
        with patch.object(self.cache, "_put_chunk_data", side_effect=blocked):
            thread = threading.Thread(target=worker)
            thread.start()
            try:
                self.assertTrue(entered.wait(2))
                self.assertEqual(other.status(OWNER, "sample", self.version)["state"], "STAGING")
                with self.assertRaises(D.CacheBusy):
                    other.unregister(ADMIN, "sample")
                self.assertEqual(list((self.cache.root / ".trash").iterdir()), [])
                self.assertTrue((self.cache._paths("sample")[".registry"] / (self.version + ".json")).exists())
            finally:
                resume.set()
                thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(other.verify(OWNER, "sample", self.version)["verified"])
        # This test times the target's publication, not a second full copy.
        # Install the real protected original after that assertion, before the
        # final removal. The busy-lock assertions above still run unchanged.
        retention = protected_original(self.cache, D, self.base/'retention-original')
        retention.bind_cache(other)
        self.assertTrue(other.unregister(ADMIN, "sample")["unregistered"])

    def test_failed_batch_fence_write_overreserves_fsynced_bytes_and_resumes(self):
        write = D._write_json
        writes = []

        def crash(path, value, *args, **kwargs):
            if Path(path).name == "TRANSFER.json" and value.get("remainingBytes") == 16:
                writes.append(value)
                raise OSError("injected batch fence fsync failure")
            return write(path, value, *args, **kwargs)

        with patch.object(D, "CHUNK_BYTES", 8), patch.object(D, "TRANSFER_BATCH_BYTES", 8), \
                patch.object(D, "_write_json", side_effect=crash):
            with self.assertRaisesRegex(OSError, "batch fence"):
                self.cache.materialize(OWNER, "sample", self.version)
        self.assertEqual(len(writes), 1)
        self.assertEqual((self.paths[".staging"] / "data" / "sample.bin").stat().st_size, 8)
        self.assertEqual(D._read_json(self.paths[".staging"] / "TRANSFER.json")["remainingBytes"], 24)
        self.assertEqual(self.cache._reserved(), 24)
        self.assertEqual(self.cache.materialize(OWNER, "sample", self.version)["state"], "READY")
        self.assertTrue(self.cache.verify(OWNER, "sample", self.version)["verified"])


if __name__ == "__main__":
    unittest.main()
