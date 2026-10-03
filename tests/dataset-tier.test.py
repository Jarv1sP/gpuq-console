"""Tier lifecycle tests on disposable local trees; no nodes or private files."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("dataset_tier_test", Path(__file__).resolve().parents[1] / "deploy" / "dataset-tier.py")
T = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(T)
D = T.D
ADMIN = D.Principal("tier-admin", True)
OWNER = D.Principal("owner")


class TierTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name).resolve()
        self.input = self.base / "approved-input"
        self.input.mkdir()
        (self.input / "sample").write_bytes(b"tiny immutable data")
        self.hot = D.DatasetCache(self.base / "hot", sources={"source": self.input}, reserve_bytes=0)
        self.cold = D.DatasetCache(self.base / "cold", sources={"source": self.input}, reserve_bytes=0)
        self.version = self.hot.register_source(ADMIN, "sample", "source", [OWNER.user_id])["version"]
        self.cold.register_source(ADMIN, "sample", "source", [OWNER.user_id])
        self.hot.materialize(OWNER, "sample", self.version)
        self.cold.materialize(OWNER, "sample", self.version)
        self.authority = T.LocalAuthority(self.cold)
        self.tier = T.DatasetTier(self.hot, authorities={"hdd": self.authority}, enabled=True, budget_bytes=1)
        self.space = patch.object(T.DatasetTier, "_space", return_value=dict(totalBytes=10**9, availableBytes=10**9))
        self.space.start()

    def tearDown(self):
        self.space.stop()
        for folder, dirs, files in os.walk(self.base):
            os.chmod(folder, 0o700)
            for name in files:
                path = Path(folder) / name
                if not path.is_symlink():
                    os.chmod(path, 0o600)
        self.tmp.cleanup()

    def certify(self):
        return self.tier.verify_authority(ADMIN, "sample", self.version, "hdd")

    def metadata(self, cache=None):
        cache = cache or self.hot
        with cache._locked():
            return cache._tier("sample", self.version)

    def write_metadata(self, value, cache=None):
        cache = cache or self.hot
        with cache._locked():
            cache._write_tier("sample", self.version, value)

    def externally_change_source_owners(self, owners):
        # Simulate privileged out-of-band repair/corruption, not an allowed API
        # mutation. Ordinary ACL changes are blocked by authority retention.
        with self.cold._locked():
            D._write_json(self.cold.root / ".registry" / "sample" / "dataset.json",
                          dict(schema=D.SCHEMA, owners=owners))

    def test_defaults_are_protected_and_gc_disabled(self):
        self.assertEqual(self.metadata()["role"], "protected")
        self.assertIsNone(self.metadata()["recovery"])
        self.assertEqual(self.tier.plan(ADMIN)["candidates"], [])
        self.certify()
        disabled = T.DatasetTier(self.hot, authorities={"hdd": self.authority}, budget_bytes=1)
        self.assertEqual((disabled.high_water, disabled.low_water), (.8, .7))
        self.assertEqual(len(disabled.collect(ADMIN)["candidates"]), 1)
        with self.assertRaises(D.CacheError):
            disabled.collect(ADMIN, dry_run=False)
        with self.assertRaises(D.CacheError):
            T.DatasetTier(self.hot, enabled=True)

    def test_legacy_metadata_absence_is_protected(self):
        (self.hot.root / ".tiers" / "sample" / (self.version + ".json")).unlink()
        self.assertEqual(self.metadata()["role"], "protected")
        self.assertEqual(self.tier.plan(ADMIN)["candidates"], [])

    def test_manifest_only_upload_is_protected_without_source(self):
        manifest = self.hot.export_manifest(OWNER, "sample", self.version)["manifest"]
        self.hot.register_manifest(ADMIN, "only-upload", manifest, [OWNER.user_id])
        with self.hot._locked():
            tier = self.hot._tier("only-upload", self.version)
        self.assertEqual(tier["role"], "protected")
        self.assertIsNone(tier["recovery"])

    def test_source_id_alone_and_forged_role_are_not_proof(self):
        value = self.metadata()
        value["role"] = "cache"
        self.write_metadata(value)
        plan = self.tier.plan(ADMIN)
        self.assertEqual(plan["candidates"], [])
        self.assertEqual(len(plan["protectedUnknown"]), 1)

    def test_full_verification_then_bounded_checks_and_safe_gc(self):
        self.certify()
        self.assertTrue(self.metadata(self.cold)["pins"])
        with patch.object(D, "_scan", side_effect=AssertionError("must not rehash")):
            plan = self.tier.plan(ADMIN)
            self.assertEqual(len(plan["candidates"]), 1)
            self.assertTrue(self.hot.status(OWNER, "sample", self.version)["state"] == "READY")
            done = self.tier.collect(ADMIN, dry_run=False)
        self.assertEqual(len(done["evicted"]), 1)
        self.assertNotEqual(self.hot.status(OWNER, "sample", self.version)["state"], "READY")
        self.assertEqual(self.cold.status(OWNER, "sample", self.version)["state"], "READY")

    def test_gc_then_recover_uses_receipt_not_stale_source_id(self):
        self.certify()
        self.assertEqual(len(self.tier.collect(ADMIN, dry_run=False)["evicted"]), 1)
        (self.input / "sample").write_bytes(b"changed external source must not be used")
        result = self.tier.recover(ADMIN, "sample", self.version)
        self.assertEqual(result["state"], "READY")
        ready = self.hot.root / "ready" / "sample" / self.version / "data" / "sample"
        self.assertEqual(ready.read_bytes(), b"tiny immutable data")
        self.assertTrue(self.hot.verify(OWNER, "sample", self.version)["verified"])

    def test_recover_after_manual_eviction_and_restart(self):
        self.certify()
        self.hot.evict(ADMIN, "sample", self.version)
        reopened = D.DatasetCache(self.hot.root, reserve_bytes=0)  # No sources at all.
        tier = T.DatasetTier(reopened, authorities={"hdd": self.authority})
        self.assertEqual(tier.recover(ADMIN, "sample", self.version)["state"], "READY")

    def test_recover_rejects_source_or_target_acl_change(self):
        self.certify()
        self.hot.evict(ADMIN, "sample", self.version)
        self.externally_change_source_owners(["changed-owner"])
        with self.assertRaises(D.CacheError):
            self.tier.recover(ADMIN, "sample", self.version)
        self.externally_change_source_owners([OWNER.user_id])
        self.hot.set_owners(ADMIN, "sample", [OWNER.user_id, "changed-owner"])
        with self.assertRaises(D.CacheError):
            self.tier.recover(ADMIN, "sample", self.version)
        self.assertNotEqual(self.hot.status(ADMIN, "sample", self.version)["state"], "READY")

    def test_mid_recover_revocation_keeps_only_staging(self):
        self.certify()
        self.hot.evict(ADMIN, "sample", self.version)
        original = self.hot._put_chunk_data
        def write_then_revoke(*args, **kwargs):
            result = original(*args, **kwargs)
            self.externally_change_source_owners(["changed-owner"])
            return result
        with patch.object(self.hot, "_put_chunk_data", side_effect=write_then_revoke):
            with self.assertRaises(D.CacheError):
                self.tier.recover(ADMIN, "sample", self.version)
        self.assertNotEqual(self.hot.status(ADMIN, "sample", self.version)["state"], "READY")

    def test_parallel_recovery_copies_once(self):
        self.certify()
        self.hot.evict(ADMIN, "sample", self.version)
        barrier, results, errors = threading.Barrier(2), [], []
        def restore():
            try:
                barrier.wait(2)
                results.append(self.tier.recover(ADMIN, "sample", self.version))
            except Exception as error:
                errors.append(error)
        original = self.hot._put_chunk_data
        with patch.object(self.hot, "_put_chunk_data", wraps=original) as writes:
            threads = [threading.Thread(target=restore) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(5)
            self.assertEqual(writes.call_count, 1)
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)

    def test_readonly_adapter_cannot_certify_or_enable_gc(self):
        class ReadOnly:
            seal = self.authority.seal
            guard = self.authority.guard
        without_recovery = T.DatasetTier(self.hot, authorities={"hdd": ReadOnly()}, enabled=True, budget_bytes=1)
        with self.assertRaisesRegex(D.CacheError, "recovery capability"):
            without_recovery.verify_authority(ADMIN, "sample", self.version, "hdd")
        self.certify()
        self.assertEqual(without_recovery.plan(ADMIN)["candidates"], [])
        with self.assertRaises(D.CacheError):
            without_recovery.recover(ADMIN, "sample", self.version)

    def test_private_materialize_hooks_not_accepted_from_requests(self):
        with self.assertRaises(D.CacheError):
            self.hot.dispatch(OWNER, dict(op="materialize", dataset="sample", version=self.version,
                                          _source=str(self.input)))
        with self.assertRaises(PermissionError):
            self.hot.materialize(OWNER, "sample", self.version, _source=self.input)

    def test_authority_pin_blocks_manual_evict_and_unregister(self):
        self.certify()
        for action in (lambda: self.cold.evict(ADMIN, "sample", self.version),
                       lambda: self.cold.unregister(ADMIN, "sample", self.version),
                       lambda: self.cold.unregister(ADMIN, "sample")):
            with self.assertRaisesRegex(D.CacheError, "pin"):
                action()

    def test_pins_and_training_leases_persist_without_expiry(self):
        self.certify()
        self.hot.pin(ADMIN, "sample", self.version, "manual-training")
        self.assertEqual(self.tier.plan(ADMIN)["candidates"], [])
        with self.assertRaises(PermissionError):
            self.hot.unpin(OWNER, "sample", self.version, "manual-training")
        self.hot.unpin(ADMIN, "sample", self.version, "manual-training")
        lease = self.hot.acquire_lease(OWNER, "sample", self.version, "transfer:1234")
        self.assertGreater(self.metadata()["lastUsedAt"], 0)
        reopened = D.DatasetCache(self.hot.root, reserve_bytes=0)
        restarted = T.DatasetTier(reopened, authorities={"hdd": self.authority}, enabled=True, budget_bytes=1)
        with patch.object(T.time, "time", return_value=10**12):
            self.assertEqual(restarted.plan(ADMIN)["candidates"], [])
        reopened.release_lease(ADMIN, "sample", self.version, lease["leaseId"])
        self.assertEqual(len(restarted.plan(ADMIN)["candidates"]), 1)

    def test_unavailable_changed_or_unpinned_authority_protects_target(self):
        self.certify()
        value = self.metadata(self.cold)
        for pin in list(value["pins"]):
            with self.assertRaisesRegex(D.CacheError, "reconciliation"):
                self.cold.unpin(ADMIN, "sample", self.version, pin)
        value["pins"] = {}  # Simulated external damage must also fail closed.
        self.write_metadata(value, self.cold)
        plan = self.tier.plan(ADMIN)
        self.assertEqual(plan["candidates"], [])
        self.assertEqual(len(plan["unavailableAuthorities"]), 1)
        self.assertEqual(self.tier.collect(ADMIN, dry_run=False)["evicted"], [])
        self.assertEqual(self.hot.status(OWNER, "sample", self.version)["state"], "READY")

    def test_first_verification_rejects_corrupt_or_writable_source(self):
        file = self.cold.root / "ready" / "sample" / self.version / "data" / "sample"
        os.chmod(file, 0o600)
        with self.assertRaisesRegex(D.CacheError, "writable"):
            self.certify()
        file.write_bytes(b"corrupt")
        os.chmod(file, 0o444)
        with self.assertRaisesRegex(D.CacheError, "verification"):
            self.certify()
        self.assertEqual(self.metadata()["role"], "protected")

    def test_receipt_write_failure_only_leaks_safe_source_pin(self):
        with patch.object(self.hot, "_write_tier", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.certify()
        self.assertEqual(self.metadata()["role"], "protected")
        self.assertTrue(self.metadata(self.cold)["pins"])

    def test_no_self_authority_and_no_cache_authority(self):
        with self.assertRaises(D.CacheError):
            T.DatasetTier(self.hot, authorities={"self": T.LocalAuthority(self.hot)})
        tier = self.metadata(self.cold)
        tier["role"] = "cache"
        self.write_metadata(tier, self.cold)
        with self.assertRaisesRegex(D.CacheError, "protected original"):
            self.certify()

    def test_unregister_and_reregister_never_reuses_receipt(self):
        self.certify()
        self.hot.unregister(ADMIN, "sample", self.version)
        self.hot.register_source(ADMIN, "sample", "source", [OWNER.user_id])
        self.assertEqual(self.metadata()["role"], "protected")
        self.assertIsNone(self.metadata()["recovery"])

    def test_orphan_authority_pin_cannot_be_reset_by_reregistration(self):
        self.certify()
        registry = self.cold.root / ".registry" / "sample" / (self.version + ".json")
        registry.unlink()
        with self.assertRaisesRegex(D.CacheError, "orphan persistent pins"):
            self.cold.register_source(ADMIN, "sample", "source", [OWNER.user_id])
        self.assertTrue(self.metadata(self.cold)["pins"])

    def test_no_pressure_no_cleanup_and_upcoming_reservation_triggers(self):
        self.certify()
        tier = T.DatasetTier(self.hot, authorities={"hdd": self.authority}, enabled=True, budget_bytes=100000)
        self.assertEqual(tier.plan(ADMIN)["candidates"], [])
        self.assertEqual(len(tier.plan(ADMIN, needed_bytes=80000)["candidates"]), 1)
        self.assertEqual(tier.plan(ADMIN, needed_bytes=80000)["reservedBytes"], 80000)

    def test_volume_watermark_and_reserve_are_real_filesystem_based(self):
        self.certify()
        tier = T.DatasetTier(self.hot, authorities={"hdd": self.authority}, enabled=True, budget_bytes=10**9)
        with patch.object(tier, "_space", return_value=dict(totalBytes=100000, availableBytes=19000)):
            plan = tier.plan(ADMIN)
        self.assertEqual(plan["requiredReclaimBytes"], 11000)
        self.assertEqual(len(plan["candidates"]), 1)

    def test_corrupt_metadata_unknown_stage_and_corrupt_lease_protected(self):
        self.certify()
        filename = self.hot.root / ".tiers" / "sample" / (self.version + ".json")
        original = filename.read_bytes()
        filename.write_text('{"schema": 999}')
        self.assertEqual(self.tier.plan(ADMIN)["candidates"], [])
        filename.write_bytes(original)
        stage = self.hot.root / ".staging" / "sample" / self.version
        stage.mkdir()
        with self.assertRaises((OSError, D.CacheError)):
            self.tier.plan(ADMIN)  # Unknown reservations fail the whole GC closed.
        stage.rmdir()
        lease = self.hot.acquire_lease(OWNER, "sample", self.version, "job")
        file = self.hot.root / ".leases" / "sample" / self.version / (lease["leaseId"] + ".json")
        file.write_text('{}')
        self.assertEqual(self.tier.plan(ADMIN)["candidates"], [])

    def test_late_lease_and_late_touch_abort_stale_gc_plan(self):
        self.certify()
        plan = self.tier.plan(ADMIN)
        lease = self.hot.acquire_lease(OWNER, "sample", self.version, "new-job")
        with patch.object(self.tier, "plan", return_value=plan):
            self.assertEqual(self.tier.collect(ADMIN, dry_run=False)["evicted"], [])
        self.hot.release_lease(ADMIN, "sample", self.version, lease["leaseId"])
        with patch.object(self.tier, "plan", return_value=plan):
            self.assertEqual(self.tier.collect(ADMIN, dry_run=False)["evicted"], [])
        self.assertEqual(self.hot.status(OWNER, "sample", self.version)["state"], "READY")

    def test_new_lease_is_serialized_with_final_quarantine(self):
        self.certify()
        entered, finished, errors, workers = threading.Event(), threading.Event(), [], []
        original = self.hot._quarantine_locked
        def acquire():
            entered.set()
            try:
                self.hot.acquire_lease(OWNER, "sample", self.version, "racing-job")
            except Exception as error:
                errors.append(error)
            finally:
                finished.set()
        def quarantine(*args, **kwargs):
            thread = threading.Thread(target=acquire)
            workers.append(thread)
            thread.start()
            self.assertTrue(entered.wait(1))
            self.assertFalse(finished.wait(.03))
            return original(*args, **kwargs)
        with patch.object(self.hot, "_quarantine_locked", side_effect=quarantine):
            result = self.tier.collect(ADMIN, dry_run=False)
        for thread in workers:
            thread.join(2)
        self.assertTrue(finished.is_set())
        self.assertEqual(len(result["evicted"]), 1)
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], D.CacheError)

    def test_no_workspace_output_or_staging_cleanup(self):
        self.certify()
        for name in (".workspaces", "outputs"):
            folder = self.hot.root / name
            folder.mkdir()
            (folder / "keep").write_bytes(b"never cache")
        self.tier.collect(ADMIN, dry_run=False)
        for name in (".workspaces", "outputs"):
            self.assertEqual((self.hot.root / name / "keep").read_bytes(), b"never cache")

    def test_authorization_and_private_proof_not_exposed(self):
        with self.assertRaises(PermissionError):
            self.tier.verify_authority(OWNER, "sample", self.version, "hdd")
        with self.assertRaises(PermissionError):
            self.tier.plan(OWNER)
        with self.assertRaises(PermissionError):
            self.hot.pin(OWNER, "sample", self.version, "pin")
        result = self.certify()
        self.assertNotIn("proof", result)
        self.assertNotIn(str(self.base), json.dumps(self.tier.plan(ADMIN)))

    def test_unknown_adapter_proof_and_missing_adapter_fail_closed(self):
        self.certify()
        tier = T.DatasetTier(self.hot, enabled=True, budget_bytes=1)
        self.assertEqual(tier.plan(ADMIN)["candidates"], [])
        value = self.metadata()
        value["recovery"]["proof"]["version"] = "0" * 64
        self.write_metadata(value)
        self.assertEqual(self.tier.plan(ADMIN)["candidates"], [])

    def test_source_acl_change_and_target_acl_expansion_prevent_gc(self):
        self.certify()
        self.externally_change_source_owners(["another-owner"])
        self.assertEqual(self.tier.plan(ADMIN)["candidates"], [])
        self.externally_change_source_owners([OWNER.user_id])
        self.assertEqual(len(self.tier.plan(ADMIN)["candidates"]), 1)
        self.hot.set_owners(ADMIN, "sample", [OWNER.user_id, "another-owner"])
        self.assertEqual(self.tier.plan(ADMIN)["candidates"], [])
        self.assertEqual(self.tier.collect(ADMIN, dry_run=False)["evicted"], [])

    def test_initial_authority_acl_must_match_target(self):
        self.cold.set_owners(ADMIN, "sample", ["another-owner"])
        with self.assertRaisesRegex(D.CacheError, "owners"):
            self.certify()
        self.assertEqual(self.metadata()["role"], "protected")

    def test_authority_retention_freezes_acl_and_source_identity(self):
        self.certify()
        with self.assertRaisesRegex(D.CacheError, "retention prevents ACL"):
            self.cold.set_owners(ADMIN, "sample", ["another-owner"])
        with self.cold._locked():
            before = self.cold._record_identity("sample", self.version)
        self.cold.attach_source(ADMIN, "sample", self.version, "source")
        self.cold.set_owners(ADMIN, "sample", [OWNER.user_id])
        with self.cold._locked():
            self.assertEqual(before, self.cold._record_identity("sample", self.version))
        # A manifest-only protected authority may not gain a different mutable
        # source mapping while its retention receipt is outstanding.
        record = self.cold.export_manifest(ADMIN, "sample", self.version)
        self.cold.register_manifest(ADMIN, "manifest-only", record["manifest"], [OWNER.user_id])
        with self.cold._locked():
            value = self.cold._tier("manifest-only", self.version)
            value["pins"]["authority-held"] = dict(owner=ADMIN.user_id, createdAt=1)
            self.cold._write_tier("manifest-only", self.version, value)
        with self.assertRaisesRegex(D.CacheError, "retention prevents source"):
            self.cold.attach_source(ADMIN, "manifest-only", self.version, "source")
        with self.assertRaisesRegex(D.CacheError, "retention prevents source"):
            self.cold.register_source(ADMIN, "manifest-only", "source", [OWNER.user_id])

    def test_mount_identity_change_refuses_gc(self):
        self.certify()
        self.cold.mount = ("old", "1:1", 1)
        with patch.object(self.cold, "_current_mount", return_value=("new", "1:1", 1)):
            self.assertEqual(self.tier.plan(ADMIN)["candidates"], [])
        self.assertEqual(self.hot.status(OWNER, "sample", self.version)["state"], "READY")

    def test_lru_order_and_bounded_batch(self):
        self.certify()
        for cache in (self.hot, self.cold):
            cache.register_source(ADMIN, "second", "source", [OWNER.user_id])
            cache.materialize(OWNER, "second", self.version)
        self.tier.verify_authority(ADMIN, "second", self.version, "hdd")
        self.hot.touch(OWNER, "sample", self.version)
        plan = self.tier.plan(ADMIN)
        self.assertEqual([r["dataset"] for r in plan["candidates"]], ["second", "sample"])
        result = self.tier.collect(ADMIN, dry_run=False, max_versions=1)
        self.assertEqual([r["dataset"] for r in result["evicted"]], ["second"])
        self.assertEqual(self.hot.status(OWNER, "sample", self.version)["state"], "READY")


if __name__ == "__main__":
    unittest.main()
