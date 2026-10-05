"""Private provenance admission; no production paths or destructive calls."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "dataset_delete_provenance_test", Path(__file__).resolve().parents[1] / "deploy" / "dataset-cache.py")
D = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D)
ADMIN = D.Principal("admin", True)
OWNER = D.Principal("member")
OTHER = D.Principal("other")
RECEIPT = "d1891e35-7aa0-4c94-ab53-e67f981cdeca"
MANIFEST = {"schema": 1, "directories": [], "files": []}


class DeleteProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache = D.DatasetCache(Path(self.temp.name) / "cache", reserve_bytes=0)

    def register(self, origin="admin", owner=OWNER, receipt=RECEIPT):
        actor = ADMIN if origin == "admin" else D.Principal(owner.user_id, True)
        with self.cache._locked():
            return self.cache._register(actor, "sample", MANIFEST, [owner.user_id], None,
                                        _origin=origin, _receipt=None if origin == "admin" else receipt)["version"]

    def proof_path(self, version):
        return self.cache.root / ".provenance" / "sample" / (version + ".json")

    def test_new_personal_origins_allow_only_authenticated_single_owner(self):
        for origin in ("upload", "workspace", "replica"):
            with self.subTest(origin=origin):
                cache = D.DatasetCache(Path(self.temp.name) / origin, reserve_bytes=0)
                with cache._locked():
                    version = cache._register(D.Principal(OWNER.user_id, True), "sample", MANIFEST,
                                              [OWNER.user_id], None, _origin=origin, _receipt=RECEIPT)["version"]
                self.assertEqual(cache.deletion_permissions(OWNER, "sample", version),
                                 {"allowed": True, "memberAllowed": True, "reason": None})
                with self.assertRaises(PermissionError):
                    cache.deletion_permissions(OTHER, "sample", version)
                self.assertEqual(cache.deletion_permissions(ADMIN, "sample", version)["allowed"], True)

    def test_single_owner_administrator_registration_is_not_personal(self):
        version = self.register()
        self.assertEqual(self.cache.deletion_permissions(OWNER, "sample", version),
                         {"allowed": False, "memberAllowed": False, "reason": "ADMIN_ONLY"})
        self.assertTrue(self.cache.deletion_permissions(ADMIN, "sample", version)["allowed"])

    def test_legacy_and_missing_proof_never_backfill_from_owner_or_name(self):
        version = self.register("upload")
        self.proof_path(version).unlink()
        with self.cache._locked():
            self.cache._register(D.Principal(OWNER.user_id, True), "sample", MANIFEST,
                                 [OWNER.user_id], None, _origin="upload", _receipt=RECEIPT)
        self.assertFalse(self.proof_path(version).exists())
        self.assertFalse(self.cache.deletion_permissions(OWNER, "sample", version)["allowed"])
        self.assertTrue(self.cache.deletion_permissions(ADMIN, "sample", version)["allowed"])

    def test_new_receipt_cannot_upgrade_an_existing_administrator_registration(self):
        version = self.register()
        before = self.proof_path(version).read_bytes()
        with self.cache._locked():
            self.cache._register(D.Principal(OWNER.user_id, True), "sample", MANIFEST,
                                 [OWNER.user_id], None, _origin="upload", _receipt=RECEIPT)
        self.assertEqual(self.proof_path(version).read_bytes(), before)
        self.assertFalse(self.cache.deletion_permissions(OWNER, "sample", version)["allowed"])

    def test_changed_registration_or_acl_invalidates_the_old_proof(self):
        version = self.register("upload")
        record = self.cache._paths("sample")[".registry"] / (version + ".json")
        D._write_json(record, D._read_json(record))
        self.assertFalse(self.cache.deletion_permissions(OWNER, "sample", version)["allowed"])

    def test_shared_acl_revokes_a_valid_personal_delete_proof(self):
        version2 = self.register("workspace", receipt="another-operation")
        self.assertTrue(self.cache.deletion_permissions(OWNER, "sample", version2)["allowed"])
        self.cache.set_owners(ADMIN, "sample", [OWNER.user_id, OTHER.user_id])
        self.assertFalse(self.cache.deletion_permissions(OWNER, "sample", version2)["allowed"])

    def test_corrupt_provenance_fails_closed_and_never_grants_deletion(self):
        version = self.register("upload")
        value = D._read_json(self.proof_path(version))
        for field, invalid in (("schema", True), ("origin", "guessed"), ("receipt", "../operation"),
                               ("owners", []), ("createdAt", float("inf")),
                               ("rootIdentity", [True, 1]), ("registrationIdentity", [])):
            with self.subTest(field=field):
                D._write_json(self.proof_path(version), {**value, field: invalid})
                with self.assertRaises(D.CacheError):
                    self.cache.deletion_permissions(OWNER, "sample", version)
        D._write_json(self.proof_path(version), value)

    def test_other_root_or_version_proof_is_not_reusable(self):
        version = self.register("upload")
        value = D._read_json(self.proof_path(version))
        D._write_json(self.proof_path(version), {**value, "rootIdentity": [0, 0]})
        self.assertFalse(self.cache.deletion_permissions(OWNER, "sample", version)["allowed"])
        D._write_json(self.proof_path(version), {**value, "version": "a" * 64})
        with self.assertRaises(D.CacheError):
            self.cache.deletion_permissions(OWNER, "sample", version)

    def test_personal_proof_requires_owner_matching_the_trusted_actor(self):
        with self.cache._locked(), self.assertRaises(PermissionError):
            self.cache._register(ADMIN, "sample", MANIFEST, [OWNER.user_id], None,
                                 _origin="upload", _receipt=RECEIPT)
        self.assertFalse(self.cache._paths("sample")[".registry"].exists())

    def test_proof_write_crash_cannot_make_a_retry_adopt_unknown_registration(self):
        with self.cache._locked(), patch.object(self.cache, "_write_provenance", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.cache._register(D.Principal(OWNER.user_id, True), "sample", MANIFEST,
                                     [OWNER.user_id], None, _origin="upload", _receipt=RECEIPT)
        version = self.register("upload")
        self.assertFalse(self.cache.deletion_permissions(OWNER, "sample", version)["allowed"])

    def test_public_adapter_cannot_supply_private_origin_proof(self):
        with self.assertRaisesRegex(D.CacheError, "unrecognized"):
            self.cache.dispatch(ADMIN, {"op": "register_manifest", "dataset": "sample",
                                       "manifest": MANIFEST, "owners": [OWNER.user_id],
                                       "_origin": "upload", "_receipt": RECEIPT})
        self.assertFalse(self.cache._paths("sample")[".registry"].exists())


if __name__ == "__main__":
    unittest.main()
