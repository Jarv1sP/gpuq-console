#!/usr/bin/env python3
"""Private cache controls over existing dataset workers and certified tier copies.

The only new worker removes one exact certified SSD copy. It is not a transfer
queue, registry deletion API, general file browser, or authority configuration.
Trusted executor adapters supply worker controls and the warehouse binding.
"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import time
import uuid

UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
TERMINAL = {"READY", "RELEASED", "CANCELED", "BLOCKED", "FAILED"}


class CacheActionNode:
    def __init__(self, module, cache, tier, folder, *, resolve=None, prepare=None,
                 prepare_identity=None, observe_prepare=None, cancel_prepare=None,
                 launch=None, active=None, stop=None):
        if tier.cache is not cache:
            raise ValueError("cache tier mismatch")
        self.D, self.cache, self.tier = module, cache, tier
        self.folder = Path(folder)
        module._mkdir(self.folder)
        self.resolve = resolve or (lambda actor, dataset, version: dataset)
        self.prepare = prepare
        self.prepare_identity = prepare_identity
        self.observe_prepare = observe_prepare
        self.cancel_prepare = cancel_prepare
        self.launch = launch
        self.active = active
        self.stop = stop

    def _key(self, key):
        if not isinstance(key, str) or not UUID.fullmatch(key) or str(uuid.UUID(key)) != key:
            raise ValueError("original cache action UUID required")
        return key

    def _ref(self, actor, dataset, version):
        self.cache._actor(actor)
        self.D._identifier(dataset)
        self.D._identifier(version, self.D.HASH_RE)
        physical = self.resolve(actor, dataset, version)
        self.D._identifier(physical)
        return physical

    def _path(self, key):
        return self.folder / (self._key(key) + ".json")

    def _read(self, actor, key):
        self.cache._actor(actor)
        row = self.D._read_json(self._path(key))
        if row.get("schema") != 1 or row.get("key") != key or row.get("owner") != actor.user_id:
            raise PermissionError("cache action is not owned by this principal")
        return row

    def _write(self, row):
        row["updatedAt"] = time.time()
        self.D._write_json(self._path(row["key"]), row)

    @contextlib.contextmanager
    def _lock(self, key):
        with self.D._directory(self.folder) as parent:
            fd = os.open(self._key(key) + ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            if self.D._regular(fd).st_uid != os.geteuid():
                raise ValueError("cache action lock owner mismatch")
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    @staticmethod
    def _view(row):
        return {key: row[key] for key in ("key", "dataset", "version", "action", "state", "phase", "errorCode") if key in row}

    def _receipt(self, actor, dataset, version):
        internal = type(actor)(actor.user_id, True)
        with self.cache._locked():
            self.cache._dataset(actor, dataset)
            tier = self.cache._tier(dataset, version)
            if tier["role"] != "cache":
                raise ValueError("CACHE_NOT_CERTIFIED")
            if tier["pins"]:
                raise ValueError("CACHE_PINNED")
            if self.cache._leases(dataset, version):
                raise ValueError("CACHE_IN_USE")
            paths = self.cache._paths(dataset, version)
            if self.cache._version_entry_exists(paths[".staging"]):
                raise ValueError("CACHE_STAGING_UNKNOWN")
            receipt = self.tier._receipt(internal, tier, dataset, version)
        return internal, receipt

    def capabilities(self, actor, dataset, version):
        physical = self._ref(actor, dataset, version)
        result = dict(protocol=1, prepare=all(callable(value) for value in
                      (self.prepare, self.prepare_identity, self.observe_prepare)), release=False,
                      prepareCancel=False, releaseCancel=True)
        if not all(callable(value) for value in (self.launch, self.active, self.stop)):
            result["reason"] = "CACHE_WORKER_UNAVAILABLE"
            return result
        try:
            internal, receipt = self._receipt(actor, physical, version)
            state = self.cache.status(actor, physical, version)
            if state["state"] != "READY":
                raise ValueError("CACHE_NOT_READY")
            with self.tier.authorities[receipt["authorityId"]].guard(internal, receipt["proof"]):
                pass
            result["release"] = True
        except (ValueError, OSError, TypeError, KeyError) as error:
            result["reason"] = str(error) if str(error).startswith("CACHE_") else "CACHE_AUTHORITY_UNCONFIRMED"
        return result

    def start(self, actor, action, dataset, version, key):
        if action not in {"prepare", "release"}:
            raise ValueError("unsupported cache action")
        physical = self._ref(actor, dataset, version)
        self._key(key)
        with self._lock(key):
            if os.path.lexists(self._path(key)):
                old = self._read(actor, key)
                if (old["action"], old["dataset"], old["version"], old["physical"]) != (action, dataset, version, physical):
                    raise ValueError("cache action UUID binding changed")
                return self.status(actor, key)
            caps = self.capabilities(actor, dataset, version)
            if caps[action] is not True:
                row = dict(schema=1, key=key, owner=actor.user_id, action=action, dataset=dataset,
                           physical=physical, version=version, state="BLOCKED", phase="BLOCKED",
                           errorCode=caps.get("reason", "CACHE_ACTION_UNAVAILABLE"))
                self._write(row)
                return self._view(row)
            row = dict(schema=1, key=key, owner=actor.user_id, action=action, dataset=dataset,
                       physical=physical, version=version, state="DISPATCHING", phase="DISPATCHING")
            if action == "prepare":
                row["nativeId"] = self.prepare_identity(actor, dataset, version)
                self.D._identifier(row["nativeId"], self.D.HASH_RE)
            self._write(row)  # original identity survives a lost launch reply
            try:
                if action == "prepare":
                    value = self.prepare(actor, dataset, version)
                    if value.get("operationId") not in (None, row["nativeId"]):
                        raise ValueError("cache prepare worker identity changed")
                    row["state"] = "READY" if value.get("state") == "READY" else "RUNNING"
                else:
                    self.launch(key)
                    row["state"] = "RUNNING"
                row["phase"] = row["state"]
            except Exception:
                row["state"] = row["phase"] = "UNKNOWN"
                row["errorCode"] = "CACHE_DISPATCH_UNCONFIRMED"
            self._write(row)
            return self._view(row)

    def status(self, actor, key):
        row = self._read(actor, self._key(key))
        if row["action"] == "prepare" and row["state"] not in {"CANCELED", "BLOCKED", "FAILED"}:
            try:
                value = self.observe_prepare(actor, row["nativeId"], row["dataset"], row["version"])
                if value.get("operationId") not in (None, row["nativeId"]) or value.get("dataset") != row["dataset"] or value.get("version") != row["version"]:
                    raise ValueError("cache prepare observation mismatch")
                if value.get("state") == "READY":
                    row["state"] = "READY"
                elif value.get("state") == "PREPARING":
                    row["state"] = "CANCELING" if row.get("cancelRequested") else "RUNNING"
                elif value.get("state") == "FAILED":
                    row["state"] = "FAILED"
                else:
                    row["state"] = "UNKNOWN"
            except Exception:
                row["state"] = "UNKNOWN"
        elif row["state"] not in TERMINAL:
            try:
                row["state"] = ("CANCELING" if row.get("cancelRequested") else "RUNNING") if self.active(key) else "UNKNOWN"
            except Exception:
                row["state"] = "UNKNOWN"
        # Read-only observation: never launches, retries, or rewrites identity.
        return self._view(row)

    def cancel(self, actor, key):
        self._key(key)
        with self._lock(key):
            row = self._read(actor, key)
            if row["action"] == "prepare" and row["state"] == "READY":
                return self.status(actor, key)
            if row["state"] in TERMINAL:
                return self._view(row)
            if row["action"] == "prepare":
                # Existing deterministic dataset workers are shared by manual
                # prepares and training. Do not infer exclusivity from owner.
                row["errorCode"] = "CACHE_SHARED_WORKER"
                self._write(row)
                return {**self._view(row), "canCancel": False}
            if row["action"] == "prepare":
                current = self.status(actor, key)
                if current["state"] == "READY":
                    return current
            row["cancelRequested"] = True
            self._write(row)
            try:
                stopped = self.stop(key)
                if stopped is not True:
                    raise ValueError("cache worker stop unconfirmed")
                # After a release entered its mutation boundary, cancellation
                # cannot claim the removed copy still exists or discard trash.
                current = self._read(actor, key)
                if current["state"] in TERMINAL:
                    return self._view(current)
                row = current
                row["state"] = "UNKNOWN" if row["phase"] in {"RELEASING", "CLEANING"} else "CANCELED"
                row["phase"] = row["state"]
                if row["state"] == "UNKNOWN":
                    row["errorCode"] = "CACHE_RELEASE_INCOMPLETE"
            except Exception:
                row["state"] = "UNKNOWN"
                row["errorCode"] = "CACHE_CANCEL_UNCONFIRMED"
            self._write(row)
            return self._view(row)

    def release_worker(self, key):
        self._key(key)
        initial = self.D._read_json(self._path(key))
        actor = self.D.Principal(initial["owner"], False)
        row = self._read(actor, key)
        if row["action"] != "release" or row["state"] in TERMINAL:
            return 0
        quarantined = []
        try:
            dataset = self._ref(actor, row["dataset"], row["version"])
            if dataset != row["physical"]:
                raise ValueError("CACHE_BINDING_CHANGED")
            internal, receipt = self._receipt(actor, dataset, row["version"])
            # Fixed protected source first; retain its guard through the final
            # target receipt/lease checks and atomic cache-only quarantine.
            with self.tier.authorities[receipt["authorityId"]].guard(internal, receipt["proof"]):
                with self.cache._version_locked(actor, dataset, row["version"]):
                    with self._lock(key):
                        row = self._read(actor, key)
                        if row.get("cancelRequested"):
                            row["state"] = row["phase"] = "CANCELED"
                            self._write(row)
                            return 0
                        with self.cache._locked():
                            self.cache._dataset(actor, dataset)
                            tier = self.cache._tier(dataset, row["version"])
                            if self.tier._receipt(internal, tier, dataset, row["version"]) != receipt:
                                raise ValueError("CACHE_BINDING_CHANGED")
                            if tier["pins"] or self.cache._leases(dataset, row["version"]):
                                raise ValueError("CACHE_IN_USE")
                            paths = self.cache._paths(dataset, row["version"])
                            if self.cache._version_entry_exists(paths[".staging"]):
                                raise ValueError("CACHE_STAGING_UNKNOWN")
                            record = self.cache._record(actor, dataset, row["version"])
                            if not self.cache._ready(paths, record["manifest"], row["version"]):
                                raise ValueError("CACHE_NOT_READY")
                            row["phase"] = "RELEASING"
                            self._write(row)
                            quarantined = self.cache._quarantine_locked(dataset, row["version"], ready_only=True)
                            row["phase"] = "CLEANING"
                            self._write(row)
            self.cache._remove_quarantined(quarantined)
            with self._lock(key):
                row = self._read(actor, key)
                row["state"] = row["phase"] = "RELEASED"
                self._write(row)
            return 0
        except Exception as error:
            with self._lock(key):
                row = self._read(actor, key)
                uncertain = quarantined or row["phase"] in {"RELEASING", "CLEANING"}
                row["state"] = "UNKNOWN" if uncertain else "BLOCKED"
                row["errorCode"] = str(error) if str(error).startswith("CACHE_") else "CACHE_AUTHORITY_UNCONFIRMED"
                self._write(row)
            return 1

    def dispatch(self, actor, operation, args):
        if not isinstance(args, dict):
            raise ValueError("invalid cache action request")
        if operation == "capabilities" and set(args) == {"dataset", "version"}:
            return self.capabilities(actor, **args)
        if operation in {"prepare", "release"} and set(args) == {"dataset", "version", "key"}:
            return self.start(actor, operation, **args)
        if operation in {"status", "cancel"} and set(args) == {"key"}:
            return getattr(self, operation)(actor, **args)
        raise ValueError("unsupported cache action or unrecognized fields")


def from_executor(executor):
    """Trusted private bridge adapter. No root/path/config accepted in requests."""
    D, cache = executor.dataset_cache()
    storage = executor.storage_node()
    folder = executor.ROOT / "dataset-cache-actions"

    def resolve(actor, dataset, version):
        warehouse = executor.storage_warehouse()
        if warehouse is not None and warehouse.contains(actor, dataset, version):
            physical = warehouse.cache_name(dataset)
            try:
                binding = warehouse.binding(physical, version)
            except FileNotFoundError:
                return dataset
            if binding is None or binding["source"] != dataset or binding["version"] != version:
                # Preparing a new warehouse cache has no binding until existing
                # worker creates it. It must never be mistaken for evictable.
                return dataset
            return physical
        return dataset

    def identity(actor, dataset, version):
        task = dict(op="prepare", dataset=dataset, version=version, userId=actor.user_id, hostAdmin=False)
        warehouse = executor.storage_warehouse()
        if warehouse is not None and warehouse.contains(actor, dataset, version):
            task["warehouse"] = True
        return hashlib.sha256(json.dumps(task, sort_keys=True).encode()).hexdigest()

    def observe(actor, native_id, dataset, version):
        current = executor.dataset_op("datasets.status", dict(userId=actor.user_id, hostAdmin=False, dataset=dataset, version=version))
        if current.get("state") == "READY":
            return {**current, "operationId": native_id}
        return executor.dataset_op("datasets.status", dict(userId=actor.user_id, hostAdmin=False, operationId=native_id))

    def unit(key):
        return "gpuq-cache-" + hashlib.sha256(key.encode()).hexdigest()[:32]

    def active(key):
        value = executor.subprocess.run(["/usr/bin/systemctl", "--user", "show", unit(key), "--property=ActiveState", "--property=SubState"], env=executor.ENV, timeout=5, capture_output=True, text=True)
        if value.returncode != 0:
            raise ValueError("cache worker status unavailable")
        fields = dict(line.split("=", 1) for line in value.stdout.splitlines() if "=" in line)
        if fields.get("ActiveState") in {"active", "activating", "deactivating", "reloading"}:
            return True
        if fields.get("ActiveState") in {"inactive", "failed"}:
            return False
        raise ValueError("cache worker state unknown")

    def stop(key):
        executor.run(["/usr/bin/systemctl", "--user", "stop", unit(key)], timeout=22)
        return not active(key)

    def launch(key):
        executor.run(["/usr/bin/systemd-run", "--user", "--collect", "--unit=" + unit(key),
                      "--property=KillMode=control-group", "--property=UMask=0077", "--property=CPUQuota=100%",
                      "--property=MemoryMax=2G", "--property=IOWeight=10", "--property=TimeoutStopSec=20",
                      "/usr/bin/python3", str(executor.HERE / "node-executor.py"), "--dataset-cache-worker", key], timeout=8)

    return CacheActionNode(D, cache, storage.tier, folder, resolve=resolve,
                          prepare=lambda actor, dataset, version: executor.dataset_op("datasets.prepare", dict(userId=actor.user_id, hostAdmin=False, dataset=dataset, version=version)),
                          prepare_identity=identity, observe_prepare=observe,
                          launch=launch, active=active, stop=stop)
