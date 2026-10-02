"""Configurable data mounts and constant-time capacity; no real mount changes."""
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "dataset_storage_guard", Path(__file__).resolve().parents[1] / "deploy" / "dataset-cache.py")
D = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D)
OWNER = D.Principal("demo-user-1")


class StorageGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "datasets"
        self.dev = self.base.stat().st_dev
        self.device = f"{os.major(self.dev)}:{os.minor(self.dev)}"

    def tearDown(self):
        self.temp.cleanup()

    def table(self, *, mount_id="2", filesystem="xfs", options="rw", target=None):
        target = str(target or self.base).replace(" ", r"\040")
        return ("1 0 99:99 / / rw - ext4 /dev/root rw\n"
                f"{mount_id} 1 {self.device} / {target} {options} - {filesystem} /dev/data {options}\n")

    def test_explicit_mount_guard_before_creating_any_cache_directory(self):
        with patch.object(D.Path, "read_text", return_value="1 0 8:1 / / rw - ext4 /dev/root rw\n"), \
                patch.object(D, "_mkdir") as mkdir:
            with self.assertRaises(D.CacheError):
                D.DatasetCache("/data1/gpuq-data/datasets", mount_point="/data1")
            mkdir.assert_not_called()

    def test_explicit_mount_allows_other_physical_root_and_tracks_identity(self):
        with patch.object(D.Path, "read_text", return_value=self.table()):
            cache = D.DatasetCache(self.root, mount_point=self.base, reserve_bytes=1024)
            self.assertEqual(cache.mount, ("2", self.device, self.dev))
            self.assertEqual(cache.list_datasets(OWNER), {"datasets": []})
            self.assertTrue(cache.capacity(OWNER)["guarded"])
        for changed in (self.table(mount_id="3"), self.table(options="ro")):
            with self.subTest(changed=changed), patch.object(D.Path, "read_text", return_value=changed):
                with self.assertRaises(D.CacheError):
                    cache.capacity(OWNER)

    def test_mount_validation_rejects_root_remote_readonly_missing_and_nested(self):
        nested = self.base / "pool" / "datasets"
        variants = [self.table().replace("99:99", self.device), self.table(filesystem="nfs4"),
                    self.table(options="ro"), self.table(target=self.base / "unrelated"),
                    self.table() + f"3 2 {self.device} / {nested} rw - xfs /dev/data rw\n",
                    self.table() + f"3 2 {self.device} / {nested}/ready rw - xfs /dev/data rw\n",
                    self.table() + f"3 2 {self.device} / {self.base}/pool rw - xfs /dev/data rw\n"]
        for table in variants:
            with self.subTest(table=table), patch.object(D.Path, "read_text", return_value=table):
                with self.assertRaises(D.CacheError):
                    D._storage_mount(self.base, nested)

    def test_sibling_mount_does_not_block_cache(self):
        table = self.table() + f"3 2 8:42 / {self.base}/unrelated rw - xfs /dev/other rw\n"
        with patch.object(D.Path, "read_text", return_value=table):
            self.assertEqual(D._storage_mount(self.base, self.root), ("2", self.device, self.dev))

    def test_mount_must_be_exact_ancestor_and_canonical(self):
        cases = [("/", "/data1/datasets"), ("/data1", "/data1"), ("/data1", "/data2/datasets"),
                 ("/data1/", "/data1/datasets"), ("/data1", "/data1//datasets")]
        for point, root in cases:
            with self.subTest(point=point, root=root), self.assertRaises(D.CacheError):
                D._storage_mount(point, root)

    def test_escaped_mountpoint_and_filesystem_device_check(self):
        point = self.base / "capacity pool"
        point.mkdir()
        with patch.object(D.Path, "read_text", return_value=self.table(target=point)):
            self.assertEqual(D._storage_mount(point, point / "datasets"), ("2", self.device, self.dev))
        with patch.object(D.Path, "read_text", return_value=self.table().replace(self.device, "98:98")):
            with self.assertRaisesRegex(D.CacheError, "changed during inspection"):
                D._storage_mount(self.base, self.root)

    def test_symlink_mountpoint_and_storage_ancestor_rejected(self):
        point = self.base / "symlink-pool"
        point.symlink_to(self.base, target_is_directory=True)
        with patch.object(D.Path, "read_text", return_value=self.table(target=point)):
            with self.assertRaises(OSError):
                D._storage_mount(point, point / "datasets")
        real = self.base / "real"
        real.mkdir()
        link = self.base / "linked"
        link.symlink_to(real, target_is_directory=True)
        with patch.object(D.Path, "read_text", return_value=self.table()):
            with self.assertRaises(OSError):
                D.DatasetCache(link / "datasets", mount_point=self.base)

    def test_replaced_cache_directory_fails_closed(self):
        cache = D.DatasetCache(self.root)
        self.root.rename(self.base / "previous-cache")
        self.root.mkdir(mode=0o700)
        with self.assertRaisesRegex(D.CacheError, "directory identity changed"):
            cache.capacity(OWNER)

    def test_capacity_no_scan_no_manifest_and_unprivileged_available_space(self):
        cache = D.DatasetCache(self.root, reserve_bytes=8192)
        fs = SimpleNamespace(f_frsize=4096, f_bsize=8192, f_blocks=1000, f_bfree=500,
                             f_bavail=400, f_files=10000, f_favail=9000)
        with patch.object(D.os, "fstatvfs", return_value=fs), \
                patch.object(D.os, "listdir", side_effect=AssertionError("capacity must not scan")), \
                patch.object(D, "_read_json", side_effect=AssertionError("capacity must not parse manifests")):
            result = cache.dispatch(OWNER, {"op": "capacity"})
        self.assertEqual(result["filesystemBytes"], 4096000)
        self.assertEqual(result["usedBytes"], 2048000)
        self.assertEqual(result["availableBytes"], 1638400)
        self.assertEqual(result["usableBytes"], 1630208)
        self.assertEqual(result["reserveBytes"], 8192)
        self.assertEqual(result["totalInodes"], 10000)
        self.assertEqual(result["availableInodes"], 9000)
        self.assertTrue(result["inodeUsageKnown"])
        self.assertFalse(result["guarded"])
        self.assertFalse(result["activeReservationsIncluded"])
        self.assertEqual(result["scope"], "filesystem")
        self.assertNotIn(str(self.root), str(result))

    def test_capacity_clamps_reserve_and_does_not_invent_inode_counts(self):
        cache = D.DatasetCache(self.root, reserve_bytes=4096)
        fs = SimpleNamespace(f_frsize=0, f_bsize=4096, f_blocks=1, f_bfree=0,
                             f_bavail=-1, f_files=0, f_favail=0)
        with patch.object(D.os, "fstatvfs", return_value=fs):
            result = cache.capacity(OWNER)
        self.assertEqual(result["availableBytes"], 0)
        self.assertEqual(result["usableBytes"], 0)
        self.assertEqual(result["filesystemBytes"], 4096)
        self.assertFalse(result["inodeUsageKnown"])
        self.assertIsNone(result["totalInodes"])
        self.assertIsNone(result["availableInodes"])

    def test_capacity_requires_trusted_principal_and_strict_request(self):
        cache = D.DatasetCache(self.root)
        with self.assertRaises(D.CacheError):
            cache.capacity({"user_id": OWNER.user_id})
        with self.assertRaises(D.CacheError):
            cache.dispatch(OWNER, {"op": "capacity", "root": "/"})


if __name__ == "__main__":
    unittest.main()
