"""Trusted storage RPC contract; uses isolated local fixtures only."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location("storage_node_test", Path(__file__).resolve().parents[1] / "deploy" / "storage-node.py")
S = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(S)
D = S.T.D
ADMIN = D.Principal("admin", True)
OWNER = D.Principal("owner")


class StorageNodeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        source = self.root / "approved-source"
        source.mkdir()
        (source / "item").write_bytes(b"data")
        self.cache = D.DatasetCache(self.root / "datasets", sources={"approved": source}, reserve_bytes=0)
        self.version = self.cache.register_source(ADMIN, "sample", "approved", [OWNER.user_id])["version"]
        self.cache.materialize(OWNER, "sample", self.version)
        self.node = S.StorageNode(self.cache)

    def tearDown(self):
        for folder, dirs, files in os.walk(self.root):
            os.chmod(folder, 0o700)
            for name in files:
                os.chmod(Path(folder) / name, 0o600)
        self.tmp.cleanup()

    def request(self, op, **extra):
        return dict(op=op, dataset="sample", version=self.version, **extra)

    def test_status_default_disabled_and_private_fields_absent(self):
        result = self.node.dispatch(ADMIN, {"op": "status"})
        self.assertFalse(result["enabled"])
        self.assertEqual((result["highWater"], result["lowWater"]), (.8, .7))
        self.assertFalse(result["automaticCollectionExposed"])
        state = self.node.dispatch(ADMIN, self.request("status"))
        self.assertEqual(state["version"]["role"], "protected")
        self.assertFalse(state["version"]["recoveryVerified"])
        self.assertNotIn(str(self.root), json.dumps(state))
        self.assertNotIn("proof", json.dumps(state))

    def test_plan_is_only_dry_run(self):
        result = self.node.dispatch(ADMIN, {"op": "plan", "neededBytes": 123})
        self.assertTrue(result["dryRun"])
        self.assertFalse(result["enabled"])
        self.assertEqual(result["reservedBytes"], 123)

    def test_manual_pin_unpin_and_lease_counts(self):
        request = self.request("pin", pinId="manual-job")
        self.assertTrue(self.node.dispatch(ADMIN, request)["pinned"])
        lease = self.cache.acquire_lease(OWNER, "sample", self.version, "job")
        result = self.node.dispatch(ADMIN, self.request("status"))["version"]
        self.assertEqual((result["pinCount"], result["leaseCount"]), (1, 1))
        self.assertTrue(self.node.dispatch(ADMIN, {**request, "op": "unpin"})["unpinned"])
        self.assertFalse(self.node.dispatch(ADMIN, {**request, "op": "unpin"})["unpinned"])
        self.cache.release_lease(ADMIN, "sample", self.version, lease["leaseId"])

    def test_member_and_spoofed_role_denied(self):
        for request in ({"op": "status"}, {"op": "plan"}, self.request("pin", pinId="p"),
                        self.request("unpin", pinId="p")):
            with self.assertRaises(PermissionError):
                self.node.dispatch(OWNER, request)
        for name in ("userId", "hostAdmin", "role", "actor"):
            with self.assertRaises(ValueError):
                self.node.dispatch(ADMIN, {"op": "status", name: True})

    def test_gc_recovery_paths_proofs_and_enable_not_rpc(self):
        bad = [{"op": "collect"}, {"op": "recover"}, {"op": "enable"},
               {"op": "plan", "dryRun": False}, {"op": "status", "enabled": True},
               self.request("status", path=str(self.root)), self.request("status", proof={}),
               {"op": "status", "dataset": "sample"}]
        for request in bad:
            with self.subTest(request=request), self.assertRaises(ValueError):
                self.node.dispatch(ADMIN, request)

    def test_authority_retention_not_removable_by_manual_rpc(self):
        for op in ("pin", "unpin"):
            with self.assertRaisesRegex(ValueError, "private reconciliation"):
                self.node.dispatch(ADMIN, self.request(op, pinId="authority-retained"))

    def test_trusted_config_validation_and_executor_adapter(self):
        executor = SimpleNamespace(CONFIG={}, dataset_cache=lambda: (D, self.cache))
        self.assertFalse(S.StorageNode.from_executor(executor).tier.enabled)
        executor.CONFIG["storageTier"] = {"enabled": True, "budgetBytes": 100000}
        node = S.StorageNode.from_executor(executor)
        self.assertTrue(node.tier.enabled)
        with self.assertRaises(ValueError):
            S.StorageNode(self.cache, policy={"enabled": True})
        with self.assertRaises(ValueError):
            S.StorageNode(self.cache, policy={"root": str(self.root)})
        with self.assertRaises(ValueError):
            S.StorageNode(self.cache, policy={"enabled": "true"})


if __name__ == "__main__":
    unittest.main()
