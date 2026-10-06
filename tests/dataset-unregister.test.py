"""Local-only unregister safety, recovery, and concurrency regressions."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from storage_test_helpers import local_data_mounts
from dataset_retention_helpers import protected_original


MODULE_PATH = Path(__file__).resolve().parents[1] / "deploy" / "dataset-cache.py"
SPEC = importlib.util.spec_from_file_location("dataset_unregister_test", MODULE_PATH)
D = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D)
ADMIN = D.Principal("test-admin", True)
OWNER = D.Principal("demo-user-1")
OTHER = D.Principal("demo-user-2")


def snapshot(path):
    """Compare contents, names and permissions without following symlinks."""
    result = {}
    if not path.exists() and not path.is_symlink():
        return result
    for item in [path, *sorted(path.rglob("*"))]:
        info = item.lstat()
        content = os.readlink(item) if stat.S_ISLNK(info.st_mode) else item.read_bytes() if stat.S_ISREG(info.st_mode) else None
        result[str(item.relative_to(path))] = (stat.S_IMODE(info.st_mode), stat.S_IFMT(info.st_mode), content)
    return result


class DatasetUnregisterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.sources = {}
        for name, content in (("alpha", b"source one\n"), ("beta", b"source two\n")):
            source = self.base / ("source-" + name)
            source.mkdir()
            (source / "data.txt").write_bytes(content)
            self.sources[name] = source
        self.original_sources = {name: snapshot(path) for name, path in self.sources.items()}
        self.root = self.base / "cache"
        self.cache = D.DatasetCache(self.root, sources=self.sources, reserve_bytes=1024, lock_timeout=0.05)
        self.original = protected_original(self.cache, D, self.base/'protected-original')

    def tearDown(self):
        try:
            self.assertEqual({name: snapshot(path) for name, path in self.sources.items()}, self.original_sources)
        finally:
            for root, _dirs, files in os.walk(self.base, followlinks=False):
                os.chmod(root, 0o700)
                for name in files:
                    path = Path(root) / name
                    if not path.is_symlink() and path.is_file():
                        path.chmod(0o600)
            self.temp.cleanup()

    def register(self, source="alpha", dataset="sample", owner=OWNER):
        return self.cache.register_source(ADMIN, dataset, source, [owner.user_id])["version"]

    def paths(self, version=None, dataset="sample"):
        return self.cache._paths(dataset, version)

    def prepare(self, source="alpha", dataset="sample", owner=OWNER):
        version = self.register(source, dataset, owner)
        self.cache.materialize(owner, dataset, version)
        return version

    def recovery(self, result):
        self.assertIsInstance(result["recoveryId"], str)
        self.assertRegex(result["recoveryId"], r"^unregister-[a-f0-9]{32}$")
        folder = self.root / ".trash" / result["recoveryId"]
        self.assertTrue(folder.is_dir())
        self.assertTrue((folder / "REMOVAL.json").is_file())
        journal = D._read_json(folder / "REMOVAL.json")
        self.assertTrue({"schema", "dataset", "version", "versions", "owners", "createdAt", "unregistered"} <= set(journal))
        self.assertEqual(journal["dataset"], result["dataset"])
        self.assertEqual(journal["version"], result["version"])
        self.assertEqual(set(journal["versions"]), set(result["versions"]))
        self.assertEqual(journal["owners"], [OWNER.user_id])
        self.assertIs(journal["unregistered"], True)
        return folder

    def assert_result(self, result, versions, version=None, changed=True):
        self.assertIs(result["unregistered"], changed)
        self.assertIs(result["registrationRetained"], False)
        self.assertEqual(result["dataset"], "sample")
        self.assertEqual(result["version"], version)
        self.assertEqual(set(result["versions"]), set(versions))

    def test_whole_dataset_removes_ready_staging_and_preserves_recovery_registration(self):
        first = self.prepare()
        second = self.register("beta")
        self.cache.plan(OWNER, "sample", second)
        other = self.prepare(dataset="other", owner=OTHER)
        other_before = {name: snapshot(path) for name, path in self.paths(dataset="other").items()}
        registration = snapshot(self.paths()[".registry"])

        result = self.cache.unregister(ADMIN, "sample")

        self.assert_result(result, [first, second])
        recovery = self.recovery(result)
        self.assertEqual(snapshot(recovery / "registration"), registration)
        self.assertFalse(self.paths()[".registry"].exists())
        for version in (first, second):
            self.assertFalse(self.paths(version)["ready"].exists())
            self.assertFalse(self.paths(version)[".staging"].exists())
        self.assertEqual({name: snapshot(path) for name, path in self.paths(dataset="other").items()}, other_before)
        self.assertTrue(self.cache.verify(OTHER, "other", other)["verified"])
        self.assertEqual(self.cache.list_datasets(OWNER), {"datasets": []})
        repeated = self.cache.unregister(ADMIN, "sample")
        self.assert_result(repeated, [], changed=False)
        self.assertIsNone(repeated["recoveryId"])
        self.assertEqual(snapshot(recovery / "registration"), registration)

    def test_single_version_preserves_other_version_and_owners_recovery_snapshot(self):
        first = self.prepare()
        second = self.prepare("beta")
        record = (self.paths()[".registry"] / (first + ".json")).read_bytes()
        owners = (self.paths()[".registry"] / "dataset.json").read_bytes()
        other_before = snapshot(self.paths(second)["ready"])
        second_record = (self.paths()[".registry"] / (second + ".json")).read_bytes()
        result = self.cache.unregister(ADMIN, "sample", first)
        self.assert_result(result, [first], first)
        recovery = self.recovery(result)
        self.assertEqual((recovery / "registration" / (first + ".json")).read_bytes(), record)
        self.assertEqual((recovery / "registration" / "dataset.json").read_bytes(), owners)
        self.assertEqual((self.paths()[".registry"] / "dataset.json").read_bytes(), owners)
        self.assertEqual((self.paths()[".registry"] / (second + ".json")).read_bytes(), second_record)
        self.assertEqual(snapshot(self.paths(second)["ready"]), other_before)
        self.assertFalse((self.paths()[".registry"] / (first + ".json")).exists())
        self.assertFalse(self.paths(first)["ready"].exists())
        self.assertTrue(self.cache.verify(OWNER, "sample", second)["verified"])
        self.assert_result(self.cache.unregister(ADMIN, "sample", first), [], first, changed=False)

    def test_active_lease_on_any_version_prevents_every_move(self):
        versions = [self.prepare(), self.prepare("beta")]
        leased = sorted(versions)[-1]
        self.cache.acquire_lease(OWNER, "sample", leased, "running-job")
        before = {name: snapshot(path) for name, path in self.paths().items()}
        with patch.object(D, "_rename_new", wraps=D._rename_new) as rename:
            with self.assertRaises(D.CacheError):
                self.cache.unregister(ADMIN, "sample")
            rename.assert_not_called()
        self.assertEqual({name: snapshot(path) for name, path in self.paths().items()}, before)
        self.assertEqual(list((self.root / ".trash").iterdir()), [])

    def test_single_version_does_not_remove_an_unrelated_active_lease(self):
        first, second = self.prepare(), self.prepare("beta")
        lease = self.cache.acquire_lease(OWNER, "sample", second, "other-version-job")
        before = snapshot(self.paths(second)[".leases"])
        self.cache.unregister(ADMIN, "sample", first)
        self.assertEqual(snapshot(self.paths(second)[".leases"]), before)
        self.assertEqual(self.cache.acquire_lease(OWNER, "sample", second, "other-version-job"), lease)

    def test_released_lease_directory_does_not_break_idempotent_removal(self):
        version = self.prepare()
        lease = self.cache.acquire_lease(OWNER, "sample", version, "finished-job")
        self.cache.release_lease(ADMIN, "sample", version, lease["leaseId"])
        self.assertTrue(self.paths(version)[".leases"].is_dir())
        self.assertTrue(self.cache.unregister(ADMIN, "sample")["unregistered"])
        self.assert_result(self.cache.unregister(ADMIN, "sample"), [], changed=False)

    def test_unpublished_orphan_staging_is_removed_without_reading_a_transfer_fence(self):
        version = self.register()
        orphan = "f" * 64
        stage = self.paths(orphan)[".staging"]
        stage.mkdir()
        (stage / "partial.bin").write_bytes(b"interrupted before TRANSFER.json")
        result = self.cache.unregister(ADMIN, "sample")
        self.assert_result(result, [version, orphan])
        self.assertFalse(stage.exists())
        self.recovery(result)

    def test_ready_and_staging_are_cleaned_before_registration_moves(self):
        first, second = self.prepare(), self.register("beta")
        self.cache.plan(OWNER, "sample", second)
        original_rename, original_remove = D._rename_new, D.shutil.rmtree
        events = []

        def rename(source, destination):
            source, destination = Path(source), Path(destination)
            if source == self.paths()[".registry"]:
                self.assertGreaterEqual(events.count("clean"), 2)
                for version in (first, second):
                    self.assertFalse(self.paths(version)["ready"].exists())
                    self.assertFalse(self.paths(version)[".staging"].exists())
                events.append("registration")
            else:
                self.assertTrue(self.paths()[".registry"].is_dir())
                self.assertTrue(any((self.root / ".trash").glob("unregister-*/REMOVAL.json")))
                events.append("quarantine")
            return original_rename(source, destination)

        def remove(path, *args, **kwargs):
            self.assertTrue(self.paths()[".registry"].is_dir())
            events.append("clean")
            return original_remove(path, *args, **kwargs)

        with patch.object(D, "_rename_new", side_effect=rename), patch.object(D.shutil, "rmtree", side_effect=remove):
            self.cache.unregister(ADMIN, "sample")
        self.assertEqual(events[-1], "registration")

    def test_version_lock_contention_is_busy_and_does_not_move_data(self):
        version = self.prepare()
        before = snapshot(self.paths()[".registry"])
        with self.cache._version_locked(OWNER, "sample", version):
            with self.assertRaises(D.CacheBusy):
                self.cache.unregister(ADMIN, "sample")
        self.assertEqual(snapshot(self.paths()[".registry"]), before)
        self.assertTrue(self.paths(version)["ready"].is_dir())
        self.assertEqual(list((self.root / ".trash").iterdir()), [])

    def test_orphan_staging_version_lock_also_blocks_whole_dataset_removal(self):
        version = self.prepare()
        orphan = "f" * 64
        staging = self.paths(orphan)[".staging"]
        staging.mkdir()
        (staging / "partial.bin").write_bytes(b"copy not yet registered")
        with self.cache._lock_file(".locks/sample." + orphan + ".lock"):
            with self.assertRaises(D.CacheBusy):
                self.cache.unregister(ADMIN, "sample")
        self.assertTrue(self.paths()[".registry"].is_dir())
        self.assertTrue(self.paths(version)["ready"].is_dir())
        self.assertEqual((staging / "partial.bin").read_bytes(), b"copy not yet registered")

    def test_real_publish_in_progress_keeps_version_lock_and_unregister_is_busy(self):
        version = self.register()
        plan = self.cache.plan(OWNER, "sample", version)
        self.cache.put_chunk(OWNER, "sample", version, "data.txt", 0,
                             (self.sources["alpha"] / "data.txt").read_bytes(), plan["token"])
        entered, resume = threading.Event(), threading.Event()
        original_scan = D._scan
        errors = []

        def delayed_scan(path):
            if Path(path) == self.paths(version)[".staging"] / "data":
                entered.set()
                if not resume.wait(3):
                    raise AssertionError("publish fixture was not resumed")
            return original_scan(path)

        def publish():
            try:
                self.cache.publish(OWNER, "sample", version, plan["token"])
            except BaseException as exc:
                errors.append(exc)

        with patch.object(D, "_scan", side_effect=delayed_scan):
            worker = threading.Thread(target=publish)
            worker.start()
            try:
                self.assertTrue(entered.wait(2))
                with self.assertRaises(D.CacheBusy):
                    self.cache.unregister(ADMIN, "sample", version)
                self.assertTrue(self.paths()[".registry"].is_dir())
                self.assertTrue(self.paths(version)[".staging"].is_dir())
            finally:
                resume.set()
                worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(self.cache.verify(OWNER, "sample", version)["verified"])

    def test_new_lease_between_snapshot_and_version_lock_is_rechecked(self):
        version = self.prepare()
        original = self.cache._lock_file
        injected = []

        @contextlib.contextmanager
        def add_lease(name):
            if name.startswith(".locks/") and not injected:
                injected.append(self.cache.acquire_lease(OWNER, "sample", version, "race-job"))
            with original(name):
                yield

        with patch.object(self.cache, "_lock_file", side_effect=add_lease), \
                patch.object(D, "_rename_new", wraps=D._rename_new) as rename:
            with self.assertRaises(D.CacheError):
                self.cache.unregister(ADMIN, "sample")
            rename.assert_not_called()
        self.assertEqual(len(injected), 1)
        self.assertTrue(self.paths(version)["ready"].is_dir())
        self.assertEqual(len(self.cache._leases("sample", version)), 1)

    def test_corrupt_lease_in_last_version_is_checked_before_any_move(self):
        versions = [self.prepare(), self.prepare("beta")]
        last = sorted(versions)[-1]
        lease = self.cache.acquire_lease(OWNER, "sample", last, "corrupt-job")
        file = self.paths(last)[".leases"] / (lease["leaseId"] + ".json")
        file.write_text("{invalid")
        before = {name: snapshot(path) for name, path in self.paths().items()}
        with patch.object(D, "_rename_new", wraps=D._rename_new) as rename:
            with self.assertRaises(D.CacheError):
                self.cache.unregister(ADMIN, "sample")
            rename.assert_not_called()
        self.assertEqual({name: snapshot(path) for name, path in self.paths().items()}, before)

    def test_rmtree_failure_keeps_registration_and_journal_for_retry(self):
        version = self.prepare()
        registration = snapshot(self.paths()[".registry"])
        with patch.object(D.shutil, "rmtree", side_effect=OSError("injected cleanup failure")):
            with self.assertRaises(OSError):
                self.cache.unregister(ADMIN, "sample")
        self.assertEqual(snapshot(self.paths()[".registry"]), registration)
        journals = list((self.root / ".trash").glob("unregister-*/REMOVAL.json"))
        self.assertEqual(len(journals), 1)
        result = self.cache.unregister(ADMIN, "sample")
        self.assert_result(result, [version])
        self.assertFalse(self.paths()[".registry"].exists())
        self.assertEqual(snapshot(self.recovery(result) / "registration"), registration)

    def test_replica_rename_failure_after_one_move_can_resume_from_journal(self):
        versions = [self.prepare(), self.prepare("beta")]
        registration = snapshot(self.paths()[".registry"])
        original = D._rename_new
        moved = []

        def fail_second_replica(source, destination):
            if self.root / "ready" in Path(source).parents:
                if moved:
                    raise OSError("injected second replica rename failure")
                moved.append(Path(source))
            return original(source, destination)

        with patch.object(D, "_rename_new", side_effect=fail_second_replica):
            with self.assertRaises(OSError):
                self.cache.unregister(ADMIN, "sample")
        self.assertEqual(len(moved), 1)
        self.assertFalse(moved[0].exists())
        self.assertEqual(snapshot(self.paths()[".registry"]), registration)
        journals = list((self.root / ".trash").glob("unregister-*/REMOVAL.json"))
        self.assertEqual(len(journals), 1)
        result = self.cache.unregister(ADMIN, "sample")
        self.assert_result(result, versions)
        self.assertEqual(result["recoveryId"], journals[0].parent.name)
        self.assertEqual(snapshot(self.recovery(result) / "registration"), registration)

    def test_registration_rename_failure_keeps_registration_and_retries(self):
        version = self.prepare()
        registration = snapshot(self.paths()[".registry"])
        original = D._rename_new

        def fail_registration(source, destination):
            if Path(source) == self.paths()[".registry"]:
                raise OSError("injected registration rename failure")
            return original(source, destination)

        with patch.object(D, "_rename_new", side_effect=fail_registration):
            with self.assertRaises(OSError):
                self.cache.unregister(ADMIN, "sample")
        self.assertEqual(snapshot(self.paths()[".registry"]), registration)
        self.assertTrue(list((self.root / ".trash").glob("unregister-*/REMOVAL.json")))
        result = self.cache.unregister(ADMIN, "sample")
        self.assert_result(result, [version])
        self.assertEqual(snapshot(self.recovery(result) / "registration"), registration)

    def test_single_version_record_rename_failure_keeps_owners_and_other_version(self):
        first, second = self.prepare(), self.prepare("beta")
        registration = snapshot(self.paths()[".registry"])
        second_replica = snapshot(self.paths(second)["ready"])
        with patch.object(self.cache, "_unregister_move_record", side_effect=OSError("injected record rename failure")):
            with self.assertRaises(OSError):
                self.cache.unregister(ADMIN, "sample", first)
        self.assertEqual(snapshot(self.paths()[".registry"]), registration)
        self.assertEqual(snapshot(self.paths(second)["ready"]), second_replica)
        journals = list((self.root / ".trash").glob("unregister-*/REMOVAL.json"))
        self.assertEqual(len(journals), 1)
        result = self.cache.unregister(ADMIN, "sample", first)
        self.assert_result(result, [first], first)
        self.assertEqual(result["recoveryId"], journals[0].parent.name)
        self.assertEqual(snapshot(self.paths(second)["ready"]), second_replica)
        self.assertTrue(self.cache.verify(OWNER, "sample", second)["verified"])

    def test_new_registration_during_cleanup_fences_the_final_whole_dataset_move(self):
        version = self.prepare()
        cleanup = self.cache._unregister_cleanup
        calls, added = [], []

        def concurrent_registration(transaction):
            calls.append(True)
            cleanup(transaction)
            if len(calls) == 2:
                added.append(self.register("beta"))

        with patch.object(self.cache, "_unregister_cleanup", side_effect=concurrent_registration):
            with self.assertRaises(D.CacheBusy):
                self.cache.unregister(ADMIN, "sample")
        self.assertEqual(len(added), 1)
        for item in (version, added[0]):
            self.assertTrue((self.paths()[".registry"] / (item + ".json")).is_file())
        self.assertEqual(len(list((self.root / ".trash").glob("unregister-*/registration"))), 0)
        result = self.cache.unregister(ADMIN, "sample")
        self.assert_result(result, [version, added[0]])
        self.recovery(result)

    def test_owner_change_during_cleanup_keeps_current_registration(self):
        version = self.prepare()
        cleanup = self.cache._unregister_cleanup
        calls = []

        def concurrent_owners(transaction):
            calls.append(True)
            cleanup(transaction)
            if len(calls) == 2:
                self.cache.set_owners(ADMIN, "sample", [OWNER.user_id, OTHER.user_id])

        with patch.object(self.cache, "_unregister_cleanup", side_effect=concurrent_owners):
            with self.assertRaises(D.CacheBusy):
                self.cache.unregister(ADMIN, "sample", version)
        self.assertEqual(self.cache._dataset(ADMIN, "sample")["owners"], [OWNER.user_id, OTHER.user_id])
        self.assertTrue((self.paths()[".registry"] / (version + ".json")).is_file())
        result = self.cache.unregister(ADMIN, "sample", version)
        recovered = self.root / ".trash" / result["recoveryId"] / "registration" / "dataset.json"
        self.assertEqual(D._read_json(recovered)["owners"], [OWNER.user_id, OTHER.user_id])

    def test_receipt_write_failure_after_atomic_commit_is_safe_to_retry(self):
        version = self.prepare()
        write = D._write_json

        def fail_completion(path, value, *args, **kwargs):
            if Path(path).name == "REMOVAL.json" and value.get("unregistered"):
                raise OSError("injected final journal write failure")
            return write(path, value, *args, **kwargs)

        with patch.object(D, "_write_json", side_effect=fail_completion):
            with self.assertRaises(OSError):
                self.cache.unregister(ADMIN, "sample")
        self.assertFalse(self.paths()[".registry"].exists())
        self.assertEqual(len(list((self.root / ".trash").glob("unregister-*/registration/" + version + ".json"))), 1)
        self.assert_result(self.cache.unregister(ADMIN, "sample"), [], changed=False)

    def test_single_record_atomic_move_never_replaces_existing_recovery_data(self):
        version = self.register()
        source = self.paths()[".registry"] / (version + ".json")
        destination = self.root / ".trash" / "existing.json"
        destination.write_bytes(b"keep existing recovery")
        before = source.read_bytes()
        with self.assertRaises(OSError):
            self.cache._unregister_move_record(source, destination)
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(destination.read_bytes(), b"keep existing recovery")

    def quarantined_ready(self):
        version = self.prepare()
        with self.cache._locked():
            current = self.cache._unregister_snapshot(ADMIN, "sample", None)
            transaction, _receipt = self.cache._unregister_transaction("sample", None, current)
        replica = transaction / "replicas" / "ready" / version
        D._rename_new(self.paths(version)["ready"], replica)
        return transaction, replica

    def test_quarantined_readonly_files_are_unlinked_without_file_chmod_or_fsync(self):
        transaction, replica = self.quarantined_ready()
        self.assertEqual((replica / "data" / "data.txt").stat().st_mode & 0o777, 0o444)
        chmod, fsync = D.os.fchmod, D.os.fsync
        changed, synced = [], []

        def directories_only(fd, mode):
            self.assertTrue(stat.S_ISDIR(os.fstat(fd).st_mode))
            changed.append(fd)
            return chmod(fd, mode)

        def parents_only(fd):
            self.assertTrue(stat.S_ISDIR(os.fstat(fd).st_mode))
            synced.append(fd)
            return fsync(fd)

        with patch.object(D.os, "fchmod", side_effect=directories_only), \
                patch.object(D.os, "fsync", side_effect=parents_only), \
                patch.object(D, "_modes", side_effect=AssertionError("must not chmod/fsync every data file")):
            self.cache._unregister_cleanup(transaction)
        self.assertFalse(replica.exists())
        self.assertEqual(len(changed), 2)  # Wrapper and data, never three regular files.
        self.assertEqual(len(synced), 1)  # Quarantine parent records the completed unlink.

    def test_cleanup_refuses_nested_symlinks_before_deleting_any_replica_file(self):
        transaction, replica = self.quarantined_ready()
        data = replica / "data"
        data.chmod(0o700)
        (data / "unsafe-link").symlink_to(self.sources["alpha"] / "data.txt")
        data.chmod(0o555)
        with self.assertRaises(D.CacheError):
            self.cache._unregister_cleanup(transaction)
        self.assertTrue((data / "unsafe-link").is_symlink())
        self.assertTrue((data / "data.txt").is_file())
        self.assertTrue((replica / "manifest.json").is_file())

    def test_cleanup_refuses_writable_by_others_directories_and_hardlinked_files(self):
        transaction, replica = self.quarantined_ready()
        data = replica / "data"
        data.chmod(0o777)
        with self.assertRaises(D.CacheError):
            self.cache._unregister_cleanup(transaction)
        self.assertTrue((data / "data.txt").is_file())
        data.chmod(0o700)
        os.link(data / "data.txt", data / "hardlink.txt")
        data.chmod(0o555)
        with self.assertRaises(D.CacheError):
            self.cache._unregister_cleanup(transaction)
        self.assertTrue((data / "hardlink.txt").is_file())
        self.assertTrue((data / "data.txt").is_file())

    def test_trusted_admin_and_valid_identifiers_are_required_before_mutation(self):
        version = self.prepare()
        before = snapshot(self.paths()[".registry"])
        for actor in (OWNER, OTHER):
            with self.subTest(actor=actor), self.assertRaises(PermissionError):
                self.cache.unregister(actor, "sample", version)
        for actor in ({"user_id": "admin", "is_admin": True}, SimpleNamespace(user_id="admin", is_admin=True), D.Principal("admin", 1)):
            with self.subTest(actor=actor), self.assertRaises(D.CacheError):
                self.cache.unregister(actor, "sample", version)
        for dataset, selected in (("../sample", None), ("/sample", version), ("sample", "../bad"), ("sample", "A" * 64), ("sample", "")):
            with self.subTest(dataset=dataset, version=selected), self.assertRaises(D.CacheError):
                self.cache.unregister(ADMIN, dataset, selected)
        self.assertEqual(snapshot(self.paths()[".registry"]), before)
        self.assertTrue(self.paths(version)["ready"].is_dir())
        self.assertEqual(list((self.root / ".trash").iterdir()), [])

    def test_registry_and_cache_symlinks_fail_closed_without_following_targets(self):
        version = self.prepare()
        self.cache.plan(OWNER, "sample", self.register("beta"))
        candidates = [self.paths()[".registry"], self.paths()[".registry"] / (version + ".json"),
                      self.paths(version)["ready"], self.paths(dataset="sample")[".staging"]]
        for index, path in enumerate(candidates):
            with self.subTest(path=path):
                outside = self.base / ("outside-" + str(index))
                if path.is_dir():
                    D._rename_new(path, outside)
                else:
                    path.rename(outside)
                path.symlink_to(outside, target_is_directory=outside.is_dir())
                before = snapshot(outside)
                try:
                    with patch.object(D, "_rename_new", wraps=D._rename_new) as rename:
                        with self.assertRaises((D.CacheError, OSError)):
                            self.cache.unregister(ADMIN, "sample")
                        rename.assert_not_called()
                    self.assertEqual(snapshot(outside), before)
                finally:
                    path.unlink()
                    if outside.is_dir():
                        D._rename_new(outside, path)
                    else:
                        outside.rename(path)

    def test_dispatch_optional_version_and_strict_field_validation(self):
        version = self.prepare()
        for request in ({"op": "unregister"}, {"op": "unregister", "version": version},
                        {"op": "unregister", "dataset": "sample", "is_admin": True},
                        {"op": "unregister", "dataset": "sample", "actor": ADMIN._asdict()},
                        {"op": "unregister", "dataset": "sample", "force": True},
                        {"op": "unregister", "dataset": "sample", "sourcePath": str(self.sources["alpha"])}):
            with self.subTest(request=request), self.assertRaises(D.CacheError):
                self.cache.dispatch(ADMIN, request)
        with self.assertRaises(PermissionError):
            self.cache.dispatch(OWNER, {"op": "unregister", "dataset": "sample"})
        self.assertTrue(self.paths(version)["ready"].is_dir())
        for selected in ("omit", None, version):
            self.prepare()
            request = {"op": "unregister", "dataset": "sample"}
            if selected != "omit":
                request["version"] = selected
            result = self.cache.dispatch(ADMIN, request)
            self.assertTrue(result["unregistered"])
            self.assertFalse((self.paths()[".registry"] / (version + ".json")).exists())

    def test_root_operator_main_supports_unregister_without_real_config_or_privilege(self):
        version = self.prepare()
        config = {"root": str(self.root), "mountPoint": str(self.base), "sources": {name: str(path) for name, path in self.sources.items()}, "reserveBytes": 1024}
        request = {"op": "unregister", "dataset": "sample", "version": None}
        output = io.StringIO()
        constructor = D.DatasetCache

        def configured_cache(*args, **kwargs):
            cache = constructor(*args, **kwargs)
            cache.rebuild_guard = self.cache.rebuild_guard
            return cache

        with local_data_mounts(self.base), patch.object(D, "_operator_config", return_value=config), \
                patch.object(D, "DatasetCache", side_effect=configured_cache), \
                patch.object(D.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode()))), \
                patch.object(D.sys, "stdout", output):
            self.assertEqual(D.main(["--config", str(self.base / "mock-config")]), 0)
        result = json.loads(output.getvalue())
        self.assertTrue(result["ok"])
        self.assert_result(result["result"], [version])
        with patch.object(D.os, "geteuid", return_value=1000), self.assertRaises(PermissionError):
            D._operator_config("/not-opened-without-root")


if __name__ == "__main__":
    unittest.main()
