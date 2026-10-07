#!/usr/bin/env python3
"""Opt-in dataset-only tier GC. No daemon, user paths, or network transport.

Construct DatasetTier with a service-owned DatasetCache and administrator-built
authority adapters. LocalAuthority implements the initial local HDD use case.
For a remote authority, seal() MUST authenticate a pinned/signed peer, perform
full fixed-version verification and durably protect its original. guard() MUST
revalidate that receipt, identity, liveness and non-expiring protection, retaining
that protection until its context exits. Request JSON is never a trusted adapter
or proof. Missing/unsupported/offline proofs fail closed. Remote integration is
intentionally not implemented here; a sourceId or successful transfer is no proof.
Adapters must also advertise recovery_protocol="dataset-tier-recovery-v1" and
implement recover(actor, proof, target_cache, target_dataset, validate_target=...),
which copies only the fixed authenticated source, honors the target version lock,
checks validate_target while holding its global lock, and verifies atomic READY.
Without that implemented recovery contract no replica may become GC eligible.

The first seal hashes the authority once. Subsequent guards check bounded metadata
and persistent pins, relying on service-owned immutable READY trees, as training
already does. Host root/service compromise or silent media corruption requires
separate scrubbing/backups; neither this policy nor a same-disk copy is a backup.
"""
from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import stat
import time

_spec = importlib.util.spec_from_file_location("dataset_tier_cache", Path(__file__).with_name("dataset-cache.py"))
D = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(D)


def _identity(path, *, directory=False):
    if directory:
        with D._directory(path) as fd:
            value = os.fstat(fd)
    else:
        with D._directory(path.parent) as parent:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                value = D._regular(fd)
            finally:
                os.close(fd)
    if value.st_mode & 0o222:
        raise D.CacheError("authority READY data must remain read-only")
    return list(D._stamp(value))


def _readonly_tree(path):
    """One-time full mode check, in addition to the full manifest hash."""
    def visit(fd):
        before = os.fstat(fd)
        if before.st_mode & 0o222:
            raise D.CacheError("authority subtree is writable")
        for name in os.listdir(fd):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                flags |= os.O_DIRECTORY
            elif not stat.S_ISREG(info.st_mode):
                raise D.CacheError("authority has an unsafe file type")
            child = os.open(name, flags, dir_fd=fd)
            try:
                if stat.S_ISDIR(info.st_mode):
                    visit(child)
                elif D._regular(child).st_mode & 0o222:
                    raise D.CacheError("authority file is writable")
            finally:
                os.close(child)
        if D._stamp(before) != D._stamp(os.fstat(fd)):
            raise D.CacheError("authority changed during verification")
    with D._directory(path) as fd:
        visit(fd)


def _persistent_mount_identity(value):
    """Stable part of the v1 seal's (mount ID, major:minor, st_dev).

    Linux mount IDs are local to a mount namespace. A PrivateTmp systemd peer
    sees another ID for the same disk sealed by an administrator's SSH process.
    Keep the original proof bytes/grant hash; its ID is diagnostic, not a
    cross-process identity. DatasetCache still checks the COMPLETE live tuple
    on every lock against that cache instance's initial observation. Root inode,
    registration, immutable READY identities, ACL and permanent pin checks below
    are unchanged. This does not permit another filesystem or an unguarded root.
    """
    if value is None:
        return None
    if (not isinstance(value, (list, tuple)) or len(value) != 3
            or not isinstance(value[0], str) or not 1 <= len(value[0]) <= 20 or not value[0].isascii()
            or not value[0].isdecimal() or int(value[0]) <= 0
            or not isinstance(value[1], str) or type(value[2]) is not int or value[2] < 0):
        raise D.CacheError("invalid persistent authority mount identity")
    try:
        device = f"{os.major(value[2])}:{os.minor(value[2])}"
    except (OverflowError, ValueError) as error:
        raise D.CacheError("invalid persistent authority device") from error
    if value[1] != device:
        raise D.CacheError("inconsistent persistent authority device")
    return value[1], value[2]


class LocalAuthority:
    """A separately configured protected DatasetCache, never a request path."""
    recovery_protocol = "dataset-tier-recovery-v1"

    def __init__(self, cache):
        self.cache = cache

    def seal(self, actor, dataset, version, pin_id):
        source = self.cache
        source._actor(actor, admin=True)
        D._identifier(pin_id)
        if not pin_id.startswith("authority-"):
            raise D.CacheError("authority sealing requires a reserved retention pin")
        with source._version_locked(actor, dataset, version, snapshot=True) as snapshot:
            record, registration = snapshot
            ready = source._paths(dataset, version)["ready"]
            with source._locked():
                owners = source._dataset(actor, dataset)["owners"]
                if source._tier(dataset, version)["role"] != "protected":
                    raise D.CacheError("authority must be a protected original, not another cache")
                if not source._ready(source._paths(dataset, version), record["manifest"], version):
                    raise D.CacheError("authority is not READY")
                identities = self._identities(ready)
            _readonly_tree(ready)
            if D._scan(ready / "data") != record["manifest"]:
                raise D.CacheError("authority full verification failed")
            with source._locked():
                source._check_snapshot(actor, dataset, version, registration)
                tier = source._tier(dataset, version)
                if (tier["role"] != "protected" or identities != self._identities(ready)
                        or source._dataset(actor, dataset)["owners"] != owners):
                    raise D.CacheError("authority changed during verification")
                # Persist source protection BEFORE handing out a receipt. A
                # crash may leak a pin, never make an unprotected source usable.
                tier["pins"].setdefault(pin_id, dict(owner=actor.user_id, createdAt=time.time()))
                source._write_tier(dataset, version, tier)
                return dict(schema=1, kind="local-protected-v1", dataset=dataset, version=version,
                            owners=owners,
                            pinId=pin_id, registration=list(registration),
                            rootIdentity=list(source._root_identity), mountIdentity=list(source.mount) if source.mount is not None else None,
                            identities=identities, fullVerified=True, verifiedAt=time.time())

    @staticmethod
    def _identities(ready):
        return dict(ready=_identity(ready, directory=True),
                    data=_identity(ready / "data", directory=True),
                    marker=_identity(ready / "READY.json"),
                    manifest=_identity(ready / "manifest.json"))

    def _validate_locked(self, actor, proof):
        """Caller owns source global lock; bounded, no full manifest parsing."""
        source = self.cache
        dataset, version = proof["dataset"], proof["version"]
        owners = source._dataset(actor, dataset)["owners"]
        tier = source._tier(dataset, version)
        mount = _persistent_mount_identity(source.mount)
        if (tier["role"] != "protected" or proof["pinId"] not in tier["pins"] or proof["owners"] != owners
                or proof["rootIdentity"] != list(source._root_identity)
                or _persistent_mount_identity(proof["mountIdentity"]) != mount
                or proof["registration"] != list(source._record_identity(dataset, version))):
            raise D.CacheError("authority receipt identity or persistent protection changed")
        ready = source._paths(dataset, version)["ready"]
        if (self._identities(ready) != proof["identities"]
                or D._read_json(ready / "READY.json") != {"schema": D.SCHEMA, "version": version}):
            raise D.CacheError("authority READY identity changed")

    @contextlib.contextmanager
    def guard(self, actor, proof, *, _hold_global=True):
        """Bounded checks and a live source version lock, no full tree/hash.

        GC holds the small global guard through quarantine. Recovery instead
        keeps the version lock and rechecks protection/ACL each copy batch.
        """
        source = self.cache
        source._actor(actor, admin=True)
        if (not isinstance(proof, dict) or set(proof) != {"schema", "kind", "dataset", "version", "pinId",
                "registration", "rootIdentity", "mountIdentity", "identities", "fullVerified", "verifiedAt", "owners"}
                or proof["schema"] != 1 or proof["kind"] != "local-protected-v1"
                or proof["fullVerified"] is not True):
            raise D.CacheError("unsupported authority verification receipt")
        dataset, version = proof["dataset"], proof["version"]
        D._identifier(dataset)
        D._identifier(version, D.HASH_RE)
        D._identifier(proof["pinId"])
        with source._locked():
            source._dataset(actor, dataset)
        # Do not use _version_locked: its preflight parses the full manifest.
        with source._lock_file(".locks/" + dataset + "." + version + ".lock"):
            with source._locked():
                self._validate_locked(actor, proof)
                # Keep the small source global lock for quarantine, so unpin
                # cannot race our last check. Never hash/delete under this lock.
                if _hold_global:
                    yield
                    return
            yield

    def recover(self, actor, proof, target_cache, target_dataset, *, validate_target):
        """Restore only this receipt's fixed protected READY tree, never sourceId."""
        target_cache._actor(actor, admin=True)
        if (target_cache._root_identity == self.cache._root_identity
                or target_cache.root in self.cache.root.parents or self.cache.root in target_cache.root.parents):
            raise D.CacheError("recovery source and target must not overlap")
        with self.guard(actor, proof, _hold_global=False):
            source = self.cache._paths(proof["dataset"], proof["version"])["ready"] / "data"
            def check():
                # materialize invokes this while holding the TARGET global
                # lock. Its version lock deduplicates every recovery attempt.
                validate_target()
                with self.cache._locked():
                    self._validate_locked(actor, proof)
            return target_cache.materialize(actor, target_dataset, proof["version"],
                                            _source=source, _guard=check)


class DatasetTier:
    def __init__(self, cache, *, authorities=None, enabled=False, budget_bytes=None,
                 high_water=.8, low_water=.7):
        if type(enabled) is not bool:
            raise D.CacheError("enabled must be boolean")
        if budget_bytes is not None and (type(budget_bytes) is not int or budget_bytes <= 0):
            raise D.CacheError("invalid tier budget")
        if any(type(v) not in (int, float) or not math.isfinite(v) for v in (low_water, high_water)) or not 0 < low_water < high_water < 1:
            raise D.CacheError("invalid tier watermarks")
        if enabled and budget_bytes is None:
            raise D.CacheError("enabling GC requires an explicit dataset budget")
        self.cache, self.enabled, self.budget_bytes = cache, enabled, budget_bytes
        self.high_water, self.low_water = high_water, low_water
        self.authorities = dict(authorities or {})
        for key, adapter in self.authorities.items():
            D._identifier(key)
            if not callable(getattr(adapter, "seal", None)) or not callable(getattr(adapter, "guard", None)):
                raise D.CacheError("authority requires a trusted seal/guard adapter")
            if isinstance(adapter, LocalAuthority):
                other = adapter.cache
                if (cache.root == other.root or cache.root in other.root.parents or other.root in cache.root.parents
                        or cache._root_identity == other._root_identity):
                    raise D.CacheError("authority must be a distinct non-overlapping cache root")
        cache.rebuild_guard = self.rebuild_guard

    @contextlib.contextmanager
    def rebuild_guard(self, actor, dataset, version):
        """Trusted last-copy check, including when automatic GC is disabled.

        Authenticate through the target cache before using its private adapter.
        A member never receives an administrator RPC or an authority token.
        The source's permanent pin and version lock protect the fixed original.
        """
        self.cache._actor(actor)
        internal = type(actor)(actor.user_id, True)
        with self.cache._locked():
            self.cache._dataset(actor, dataset)
            receipt = self._receipt(internal, self.cache._tier(dataset, version), dataset, version)
        adapter = self.authorities[receipt["authorityId"]]
        guard = (adapter.guard(internal, receipt["proof"], _hold_global=False)
                 if isinstance(adapter, LocalAuthority) else adapter.guard(internal, receipt["proof"]))
        with guard:
            with self.cache._locked():
                self.cache._dataset(actor, dataset)
                if self._receipt(internal, self.cache._tier(dataset, version), dataset, version) != receipt:
                    raise D.CacheError("protected original changed during removal")
            yield

    @staticmethod
    def _recoverable(adapter):
        return (getattr(adapter, "recovery_protocol", None) == "dataset-tier-recovery-v1"
                and callable(getattr(adapter, "recover", None)))

    def verify_authority(self, actor, dataset, version, authority_id, authority_dataset=None):
        cache = self.cache
        cache._actor(actor, admin=True)
        D._identifier(authority_id)
        if authority_id not in self.authorities:
            raise D.CacheError("authority is not configured")
        if not self._recoverable(self.authorities[authority_id]):
            raise D.CacheError("authority has no implemented fixed-version recovery capability")
        authority_dataset = dataset if authority_dataset is None else authority_dataset
        D._identifier(authority_dataset)
        with cache._locked():
            record = cache._record(actor, dataset, version)
            owners = cache._dataset(actor, dataset)["owners"]
            if not cache._ready(cache._paths(dataset, version), record["manifest"], version):
                raise D.CacheError("only READY replicas may become caches")
            if cache._tier(dataset, version)["pins"]:
                raise D.CacheError("pinned originals cannot become disposable caches")
            registration = cache._record_identity(dataset, version)
        pin_id = "authority-" + hashlib.sha256(D._json_bytes([list(cache._root_identity), dataset, version, authority_id])).hexdigest()[:54]
        adapter = self.authorities[authority_id]
        proof = adapter.seal(actor, authority_dataset, version, pin_id)
        # Proofs are generated by a trusted adapter, not accepted from requests.
        proof = json.loads(D._json_bytes(proof))
        if (not isinstance(proof, dict) or proof.get("version") != version
                or proof.get("dataset") != authority_dataset or proof.get("owners") != owners):
            raise D.CacheError("authority returned a different fixed version or owners")
        with adapter.guard(actor, proof):
            with cache._version_locked(actor, dataset, version):
                with cache._locked():
                    cache._check_snapshot(actor, dataset, version, registration)
                    if cache._dataset(actor, dataset)["owners"] != owners:
                        raise D.CacheError("target owners changed during authority verification")
                    record = cache._record(actor, dataset, version)
                    if not cache._ready(cache._paths(dataset, version), record["manifest"], version):
                        raise D.CacheError("target stopped being READY")
                    tier = cache._tier(dataset, version)
                    if tier["pins"]:
                        raise D.CacheError("pinned originals cannot become disposable caches")
                    tier.update(role="cache", lastUsedAt=max(tier["lastUsedAt"], time.time()),
                                recovery=dict(schema=1, authorityId=authority_id, version=version,
                                              registration=list(registration), owners=owners, proof=proof))
                    cache._write_tier(dataset, version, tier)
        return dict(dataset=dataset, version=version, role="cache", verified=True, authorityId=authority_id)

    def _receipt(self, actor, tier, dataset, version, *, _read_only=False):
        receipt = tier["recovery"]
        if (tier["role"] != "cache" or not isinstance(receipt, dict)
                or set(receipt) != {"schema", "authorityId", "version", "registration", "proof", "owners"}
                or receipt["schema"] != 1 or receipt["version"] != version
                or receipt["authorityId"] not in self.authorities
                or not self._recoverable(self.authorities[receipt["authorityId"]])
                or receipt["owners"] != self.cache._dataset(actor, dataset)["owners"]
                or receipt["registration"] != list(self.cache._record_identity(dataset, version, _read_only=_read_only))):
            raise D.CacheError("no valid fixed-version recovery receipt")
        return receipt

    def retirement_references(self, actor, dataset, version, *, _read_only=False):
        """Private grant relationship projection, never inferred from sourceId."""
        self.cache._actor(actor)
        internal=type(actor)(actor.user_id,True)
        with self.cache._locked():
            self.cache._dataset(actor,dataset)
            tier=self.cache._tier(dataset,version)
            if tier['role']!='cache':return []
            receipt=self._receipt(internal,tier,dataset,version,_read_only=_read_only)
        adapter=self.authorities[receipt['authorityId']]
        project=getattr(adapter,'retirement_reference',None)
        if not callable(project):raise D.CacheError('authority dependency has no fixed machine/reference proof')
        return [project(internal,receipt['proof'])]

    def recover(self, actor, dataset, version):
        """Trusted worker recovery; no paths, endpoints or receipts from callers."""
        self.cache._actor(actor, admin=True)
        with self.cache._locked():
            self.cache._record(actor, dataset, version)
            receipt = self._receipt(actor, self.cache._tier(dataset, version), dataset, version)
        adapter = self.authorities[receipt["authorityId"]]
        def validate_target():
            # Adapter invokes under destination global lock before I/O and READY.
            if self._receipt(actor, self.cache._tier(dataset, version), dataset, version) != receipt:
                raise D.CacheError("recovery receipt changed while preparing data")
        result = adapter.recover(actor, receipt["proof"], self.cache, dataset,
                                 validate_target=validate_target)
        with self.cache._locked():
            validate_target()
            record = self.cache._record(actor, dataset, version)
            if not self.cache._ready(self.cache._paths(dataset, version), record["manifest"], version):
                raise D.CacheError("authority recovery did not publish the fixed version READY")
            self.cache._touch_locked(dataset, version)
        return dict(dataset=dataset, version=version, state="READY", recovered=True)

    def _space(self):
        with D._directory(self.cache.root) as fd:
            info = os.fstatvfs(fd)
        return dict(totalBytes=info.f_blocks * info.f_frsize,
                    availableBytes=info.f_bavail * info.f_frsize)

    def _inventory_locked(self, actor):
        """Registry enumeration only; never inspect workspaces, outputs or trash."""
        rows, unknown, usage = [], [], 0
        with D._directory(self.cache.root / ".registry") as fd:
            datasets = sorted(os.listdir(fd))
        for dataset in datasets:
            try:
                D._identifier(dataset)
                with D._directory(self.cache.root / ".registry" / dataset) as fd:
                    versions = sorted(os.listdir(fd))
                for name in versions:
                    if name == "dataset.json" or name.startswith(".write-"):
                        continue
                    try:
                        version = D._identifier(name[:-5], D.HASH_RE) if name.endswith(".json") else D._identifier("")
                        record = self.cache._record(actor, dataset, version)
                        paths = self.cache._paths(dataset, version)
                        if not self.cache._ready(paths, record["manifest"], version):
                            continue
                        manifest = record["manifest"]
                        # Conservative admission footprint, not promised freed
                        # physical bytes (sparse files and filesystem differ).
                        size = self.cache._footprint(manifest)
                        usage += size
                        tier = self.cache._tier(dataset, version)
                        if tier["role"] != "cache" or tier["pins"] or self.cache._leases(dataset, version):
                            continue
                        self._receipt(actor, tier, dataset, version)
                        with D._directory(paths[".staging"].parent) as fd:
                            if version in os.listdir(fd):
                                raise D.CacheError("READY with staging has unknown lifecycle")
                        rows.append(dict(dataset=dataset, version=version, bytes=size, lastUsedAt=tier["lastUsedAt"]))
                    except (ValueError, OSError, TypeError, KeyError):
                        unknown.append(dict(dataset=dataset, version=name[:-5] if name.endswith(".json") else "unknown"))
            except (ValueError, OSError, TypeError, KeyError):
                unknown.append(dict(dataset=dataset, version="unknown"))
        return sorted(rows, key=lambda r: (r["lastUsedAt"], r["dataset"], r["version"])), unknown, usage

    def plan(self, actor, *, needed_bytes=0, _exclude=()):
        self.cache._actor(actor, admin=True)
        if type(needed_bytes) is not int or needed_bytes < 0:
            raise D.CacheError("invalid upcoming reservation")
        # Internal preparation workers may retain their own exact fixed target
        # during preflight. This is not accepted by any request/RPC parser.
        excluded = set()
        for dataset, version in _exclude:
            excluded.add((D._identifier(dataset), D._identifier(version, D.HASH_RE)))
        with self.cache._locked():
            rows, unknown, usage = self._inventory_locked(actor)
            space = self._space()
            reserved = self.cache._reserved() + needed_bytes
            # Logical budget includes all staged payload, not just bytes still
            # to copy. Physical pressure separately uses remaining writes.
            committed = self.cache._budget_usage() + needed_bytes if self.budget_bytes is not None else usage + reserved
        available, total = space["availableBytes"], space["totalBytes"]
        disk_used = total - available + reserved
        disk_need = max(0, math.ceil(disk_used - total * self.low_water)) if disk_used >= total * self.high_water else 0
        reserve_need = max(0, self.cache.reserve_bytes + reserved - available)
        budget_need = max(0, math.ceil(committed - self.budget_bytes * self.low_water)) if self.budget_bytes is not None and committed >= self.budget_bytes * self.high_water else 0
        needed = max(disk_need, reserve_need, budget_need)
        selected, invalid, projected = [], [], 0
        for row in rows:
            if (row["dataset"], row["version"]) in excluded:
                continue
            try:
                with self.cache._locked():
                    receipt = self._receipt(actor, self.cache._tier(row["dataset"], row["version"]), row["dataset"], row["version"])
                with self.authorities[receipt["authorityId"]].guard(actor, receipt["proof"]):
                    pass
            except (ValueError, OSError, TypeError, KeyError):
                invalid.append(dict(dataset=row["dataset"], version=row["version"], reason="authority-unverified-or-unavailable"))
                continue
            if projected < needed:
                selected.append(row)
                projected += row["bytes"]
        return dict(enabled=self.enabled, dryRun=True, budgetBytes=self.budget_bytes,
                    highWater=self.high_water, lowWater=self.low_water, usageBytes=usage,
                    budgetCommittedBytes=committed,
                    reservedBytes=reserved, availableBytes=available, requiredReclaimBytes=needed,
                    projectedReclaimBytes=projected, sufficient=projected >= needed,
                    candidates=selected, protectedUnknown=unknown, unavailableAuthorities=invalid)

    def collect(self, actor, *, dry_run=True, needed_bytes=0, max_versions=16, _exclude=()):
        self.cache._actor(actor, admin=True)
        if type(dry_run) is not bool or type(max_versions) is not int or not 1 <= max_versions <= 1000:
            raise D.CacheError("invalid GC request")
        if not dry_run and not self.enabled:
            raise D.CacheError("automatic cache collection is disabled")
        plan = self.plan(actor, needed_bytes=needed_bytes, _exclude=_exclude)
        if dry_run:
            return plan
        evicted, skipped = [], []
        for row in plan["candidates"][:max_versions]:
            dataset, version = row["dataset"], row["version"]
            quarantined = []
            try:
                with self.cache._locked():
                    receipt = self._receipt(actor, self.cache._tier(dataset, version), dataset, version)
                # Source guard first, then target version/global locks. Source
                # adapters MUST NOT call target APIs or wait for target work.
                with self.authorities[receipt["authorityId"]].guard(actor, receipt["proof"]):
                    with self.cache._version_locked(actor, dataset, version):
                        with self.cache._locked():
                            record = self.cache._record(actor, dataset, version)
                            tier = self.cache._tier(dataset, version)
                            if (self._receipt(actor, tier, dataset, version) != receipt
                                    or tier["lastUsedAt"] != row["lastUsedAt"]
                                    or not self.cache._ready(self.cache._paths(dataset, version), record["manifest"], version)):
                                raise D.CacheError("candidate changed since planning")
                            with D._directory(self.cache._paths(dataset, version)[".staging"].parent) as fd:
                                if version in os.listdir(fd):
                                    raise D.CacheError("unknown simultaneous staging state")
                            quarantined = self.cache._quarantine_locked(dataset, version, ready_only=True)
                # Release source and metadata locks before recursive cleanup.
                self.cache._remove_quarantined(quarantined)
                evicted.append(dict(dataset=dataset, version=version))
            except (ValueError, OSError, TypeError, KeyError):
                skipped.append(dict(dataset=dataset, version=version, reason="changed-or-unverified"))
        return dict(dryRun=False, evicted=evicted, skipped=skipped,
                    after=self.plan(actor, needed_bytes=needed_bytes, _exclude=_exclude))
