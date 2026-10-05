#!/usr/bin/env python3
"""Controlled, immutable node-local dataset replicas (Python standard library).

The service constructs Principal from its authenticated identity, NEVER from a
request's role/user fields. Source IDs and paths are trusted administrator config.
This module executes no external commands. All replicas live under /data2/datasets
by default; tests may explicitly supply an isolated root.

Lifecycle: register_source / register_manifest -> plan -> put_chunk or trusted
transport -> publish -> acquire_lease -> scheduler-confirmed release_lease.
Only the final atomic rename makes a version READY. A staging directory, even one
containing READY.json after a crash, is not a published version. Leases never age
out automatically. The executor MUST bind the returned data path read-only and
release a lease only after confirming that its job and all steps have stopped.

Like gpuq/sync.py this uses a durable not-ready fence, safe paths, resume and
source stability checks, rather than an overwrite/delete mirror. Unlike its
rsync receiver, this library deliberately has no shell/command transport. An
administrator can obtain prepare_transfer's target for a trusted rsync process;
that process MUST exit and close every writer before publish. Do not expose that
host path or an arbitrary rsync endpoint to ordinary users. A service-owned cache
and trusted transport are assumptions, not protection from a compromised root.

Local root-only CLI (JSON request on stdin, JSON result on stdout):
  sudo python3 dataset-cache.py --config /etc/gpuq/datasets.json
Config: {"root":"/data2/datasets", "mountPoint":"/data2", "sources":{"tiny":"/data2/imports/tiny"},
         "reserveBytes":10737418240, "serviceUid":1000, "serviceGid":1000}
Requests use {"op":"register_source", "dataset":"tiny", "sourceId":"tiny",
              "owners":["demo-user-1"]}, then {"op":"materialize", ...}.
This is a privileged operator CLI, not a setuid program or a user-facing API.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import ctypes
import errno
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import time
import uuid
from typing import NamedTuple


SCHEMA = 1
CHUNK_BYTES = 1024 * 1024
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_ENTRIES = 500000
CATALOG_SUMMARY_BYTES = 4096
CATALOG_SUMMARY_ROWS = 256
TRANSFER_BATCH_BYTES = 64 * 1024 * 1024
TRANSFER_BATCH_FILES = 256
TRANSFER_BATCH_SECONDS = 1.0
DEFAULT_RESERVE = 10 * 1024**3
ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
USER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}\Z")
HASH_RE = re.compile(r"[a-f0-9]{64}\Z")
UNSAFE_RELATIVE_RE = re.compile(r"[\x00-\x1f\x7f\\]")
FORBIDDEN = {".ssh", ".env", ".git", ".venv", "anaconda3", "miniconda3", ".conda"}
BROAD = {"/", "/home", "/Users", "/root", "/data1", "/data2", "/tmp", "/var/tmp"}
SYSTEM = ("/etc", "/usr", "/bin", "/sbin", "/proc", "/sys", "/dev", "/run", "/var/lib")


class CacheError(ValueError):
    """A request cannot safely proceed; no version should be consumed."""


class CacheBusy(CacheError):
    """Another operation holds a lock; callers may retry without assuming readiness."""


class Principal(NamedTuple):
    user_id: str
    is_admin: bool = False


def _identifier(value, pattern=ID_RE):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise CacheError("invalid identifier")
    return value


def _relative(value):
    if (not isinstance(value, str) or not value or len(value.encode()) > 4096
            or value.startswith("/") or UNSAFE_RELATIVE_RE.search(value)):
        raise CacheError("invalid relative dataset path")
    parts = value.split("/")
    if any(p in {"", ".", ".."} or p in FORBIDDEN for p in parts):
        raise CacheError("unsafe or credential/environment dataset path")
    return value


def _absolute(value):
    value = os.fspath(value)
    if (not value.startswith("/") or ".." in Path(value).parts or "\\" in value
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise CacheError("expected an absolute path without traversal")
    return Path(value)


@contextlib.contextmanager
def _directory(path):
    """Open every component without following symlinks, including ancestors."""
    path = _absolute(path)
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def _mkdir(path):
    with _directory(path.parent) as parent:
        try:
            os.mkdir(path.name, 0o700, dir_fd=parent)
            os.fsync(parent)
        except FileExistsError:
            pass
        fd = os.open(path.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise CacheError("cache directory must be owned by the service and not writable by others")
        finally:
            os.close(fd)


def _json_bytes(value):
    data = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    if len(data) > MAX_JSON_BYTES:
        raise CacheError("manifest/metadata too large")
    return data


def _regular(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise CacheError("dataset files must be regular files with a single link")
    return info


def _read_json(path):
    with _directory(path.parent) as parent:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = _regular(fd)
            if info.st_size > MAX_JSON_BYTES:
                raise CacheError("metadata too large")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                return json.loads(stream.read(MAX_JSON_BYTES + 1))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise CacheError("corrupt dataset metadata; refusing to proceed") from exc
        finally:
            os.close(fd)


def _write_json(path, value, mode=0o600):
    data = _json_bytes(value)
    temporary = ".write-" + uuid.uuid4().hex
    with _directory(path.parent) as parent:
        # An interrupted atomic metadata write may leave a private temporary
        # file. No data files live in metadata directories; remove only this
        # helper's exact naming pattern, after nofollow/owner/single-link checks.
        for name in os.listdir(parent):
            if not re.fullmatch(r"\.write-[a-f0-9]{32}", name):
                continue
            stale = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                if _regular(stale).st_uid != os.geteuid():
                    raise CacheError("unexpected owner of interrupted metadata write")
            finally:
                os.close(stale)
            os.unlink(name, dir_fd=parent)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
        try:
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(data)
                stream.flush()
                os.fsync(fd)
            os.replace(temporary, path.name, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            os.close(fd)
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass


def _stamp(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _digest_fd(fd, length=None):
    before = _regular(fd)
    digest = hashlib.sha256()
    remaining = before.st_size if length is None else length
    if remaining > before.st_size:
        raise CacheError("file shorter than expected")
    os.lseek(fd, 0, os.SEEK_SET)
    while remaining:
        data = os.read(fd, min(CHUNK_BYTES, remaining))
        if not data:
            raise CacheError("file changed while being read")
        digest.update(data)
        remaining -= len(data)
    if _stamp(before) != _stamp(_regular(fd)):
        raise CacheError("file changed while being read")
    return digest.hexdigest(), before.st_size


def _canonical_json_matches(path, digest):
    """Check published canonical bytes, bounded and stable, without JSON parse.

    READY manifests are written by _write_json after full tree verification.
    Their canonical bytes hash is the immutable version already validated from
    the registry. A semantically equivalent but noncanonical replacement fails
    closed; this helper never accepts a cached readiness flag or user digest.
    """
    with _directory(path.parent) as parent:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            before = _regular(fd)
            if before.st_size > MAX_JSON_BYTES:
                raise CacheError("metadata too large")
            actual, size = _digest_fd(fd, before.st_size)
            if size != before.st_size or _stamp(before) != _stamp(_regular(fd)):
                raise CacheError("file changed while being read")
            return actual == digest
        finally:
            os.close(fd)


def _manifest_bytes(value):
    if not isinstance(value, dict) or set(value) != {"schema", "directories", "files"} or value["schema"] != SCHEMA:
        raise CacheError("unsupported manifest schema")
    dirs, files = value["directories"], value["files"]
    if not isinstance(dirs, list) or not isinstance(files, list) or len(dirs) + len(files) > MAX_ENTRIES:
        raise CacheError("invalid manifest entries")
    directories = sorted(_relative(p) for p in dirs)
    normalized, seen = [], set(directories)
    if len(seen) != len(directories):
        raise CacheError("duplicate manifest directory")
    for item in files:
        if not isinstance(item, dict) or set(item) != {"path", "size", "sha256"}:
            raise CacheError("invalid manifest file")
        path = _relative(item["path"])
        if path in seen or type(item["size"]) is not int or not 0 <= item["size"] <= 2**63 - 1:
            raise CacheError("duplicate path or invalid file size")
        _identifier(item["sha256"], HASH_RE)
        seen.add(path)
        normalized.append(dict(path=path, size=item["size"], sha256=item["sha256"]))
    directory_set = set(directories)
    # Direct-parent closure is sufficient because directories are entries too;
    # _relative has already rejected empty, dot and traversal components.
    for path in seen:
        parent = path.rpartition("/")[0]
        if parent and parent not in directory_set:
            raise CacheError("manifest missing parent directory or conflicting file path")
    result = dict(schema=SCHEMA, directories=directories, files=sorted(normalized, key=lambda f: f["path"]))
    return result, _json_bytes(result)


def _manifest(value):
    return _manifest_bytes(value)[0]


def _scan(path):
    directories, files = [], []
    def visit(fd, prefix):
        before = os.fstat(fd)
        for name in sorted(os.listdir(fd)):
            relative = _relative(prefix + name)
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    directories.append(relative)
                    visit(child, relative + "/")
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    digest, size = _digest_fd(child)
                    files.append(dict(path=relative, size=size, sha256=digest))
                finally:
                    os.close(child)
            else:
                raise CacheError("symlinks and special files are not supported")
            if len(files) + len(directories) > MAX_ENTRIES:
                raise CacheError("too many dataset entries")
        if _stamp(before) != _stamp(os.fstat(fd)):
            raise CacheError("directory changed while being scanned")
    with _directory(path) as fd:
        visit(fd, "")
    return _manifest(dict(schema=SCHEMA, directories=directories, files=files))


def _version(manifest):
    return hashlib.sha256(_json_bytes(manifest)).hexdigest()


def _rename_new(source, destination):
    """Atomic no-replace publication, Linux and macOS; unsupported OS fails closed."""
    with _directory(source.parent) as source_fd, _directory(destination.parent) as destination_fd:
        if os.fstat(source_fd).st_dev != os.fstat(destination_fd).st_dev:
            raise CacheError("staging and published version must be on the same filesystem")
        libc = ctypes.CDLL(None, use_errno=True)
        if sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
            fn = libc.renameat2
            flags = 1  # RENAME_NOREPLACE
        elif sys.platform == "darwin" and hasattr(libc, "renameatx_np"):
            fn = libc.renameatx_np
            flags = 4  # RENAME_EXCL
        else:
            raise CacheError("atomic no-replace rename unavailable on this platform")
        fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        fn.restype = ctypes.c_int
        # Moving a directory between parents may require write permission to
        # update '..'. Only the private wrapper is temporarily writable; the
        # immutable data subtree stays unchanged. API readers use the same lock.
        with _directory(source) as moved_fd:
            mode = stat.S_IMODE(os.fstat(moved_fd).st_mode)
            try:
                os.fchmod(moved_fd, mode | stat.S_IWUSR)
                result = fn(source_fd, os.fsencode(source.name), destination_fd, os.fsencode(destination.name), flags)
                saved_errno = ctypes.get_errno()
            finally:
                os.fchmod(moved_fd, mode)
                os.fsync(moved_fd)
            ctypes.set_errno(saved_errno)
        if result:
            code = ctypes.get_errno()
            if code == errno.EXDEV:
                raise CacheError("cross-filesystem publication is forbidden")
            raise OSError(code, os.strerror(code))
        os.fsync(destination_fd)
        os.fsync(source_fd)


def _modes(path, readonly):
    def visit(fd):
        for name in os.listdir(fd):
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    visit(child)
                finally:
                    os.close(child)
            else:
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    _regular(child)
                    os.fchmod(child, 0o444 if readonly else 0o600)
                    os.fsync(child)
                finally:
                    os.close(child)
        os.fchmod(fd, 0o555 if readonly else 0o700)
        os.fsync(fd)
    with _directory(path) as fd:
        visit(fd)


def _storage_mount(mount_point, cache_root):
    """Verify an exact local data mount and reject nested cache mounts.

    A configurable cache root must not weaken the /data2 safety properties:
    failed mounts cannot redirect writes to /, and a child mount cannot silently
    put only some of a replica or workspace on another filesystem.
    """
    point, cache = _absolute(mount_point), _absolute(cache_root)
    if (str(point) != os.fspath(mount_point) or str(cache) != os.fspath(cache_root)
            or point == Path("/") or point not in cache.parents):
        raise CacheError("cache root must be below its exact required data mount")
    rows = []
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        left, separator, right = line.partition(" - ")
        before, after = left.split(), right.split()
        if not separator or len(before) < 6 or len(after) < 3:
            raise CacheError("invalid mount table; refusing dataset access")
        target = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), before[4])
        rows.append(dict(id=before[0], device=before[2], target=target, filesystem=after[0],
                         options=before[5].split(",") + after[2].split(",")))
    data = [r for r in rows if r["target"] == str(point)]
    root = [r for r in rows if r["target"] == "/"]
    local = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "bcachefs"}
    if (not data or not root or data[-1]["device"] == root[-1]["device"]
            or data[-1]["filesystem"] not in local or "ro" in data[-1]["options"]
            or "rw" not in data[-1]["options"]):
        raise CacheError("required data mount must be an exact writable local non-root filesystem mount")
    if any(Path(r["target"]) != point and (Path(r["target"]) == cache
               or cache in Path(r["target"]).parents
               or (point in Path(r["target"]).parents and Path(r["target"]) in cache.parents))
           for r in rows):
        raise CacheError("dataset cache submounts are not supported")
    with _directory(point) as fd:
        device = os.fstat(fd).st_dev
    if str(os.major(device)) + ":" + str(os.minor(device)) != data[-1]["device"]:
        raise CacheError("data mount changed during inspection")
    return data[-1]["id"], data[-1]["device"], device


def _data2_mount():
    """Compatibility entry point for the original default storage layout."""
    return _storage_mount("/data2", "/data2/datasets")


class DatasetCache:
    def __init__(self, root="/data2/datasets", *, sources=None, reserve_bytes=DEFAULT_RESERVE,
                 lock_timeout=2.0, mount_point=None):
        self.root = _absolute(root)
        if str(self.root) in BROAD or type(reserve_bytes) is not int or reserve_bytes < 0:
            raise CacheError("unsafe cache root or reserve")
        self.reserve_bytes = reserve_bytes
        if not isinstance(lock_timeout, (int, float)) or isinstance(lock_timeout, bool) or not 0 <= lock_timeout <= 60:
            raise CacheError("invalid dataset lock timeout")
        self.lock_timeout = lock_timeout
        # Explicit mountPoint is mandatory for non-/data2 production layouts.
        # Isolated temporary roots remain available to unprivileged unit tests.
        self.mount_point = (_absolute(mount_point) if mount_point is not None
                            else Path("/data2") if Path("/data2") in self.root.parents else None)
        if mount_point is not None and str(self.mount_point) != os.fspath(mount_point):
            raise CacheError("required data mount must be an exact absolute path")
        self.mount = self._current_mount() if self.mount_point is not None else None
        self.sources = dict(sources or {})
        for key, value in self.sources.items():
            _identifier(key)
            path = _absolute(value)
            if (str(path) in BROAD or path.parent in (Path("/home"), Path("/Users"))
                    or any(p in FORBIDDEN for p in path.parts)
                    or any(path == Path(p) or Path(p) in path.parents for p in SYSTEM)
                    or path == self.root or path in self.root.parents or self.root in path.parents):
                raise CacheError("unsafe approved source directory")
            self.sources[key] = path
        _mkdir(self.root)
        with _directory(self.root) as fd:
            info = os.fstat(fd)
            if self.mount is not None and info.st_dev != self.mount[2]:
                raise CacheError("cache no longer resides on the verified data mount")
            self._root_identity = info.st_dev, info.st_ino
        for name in (".registry", ".staging", "ready", ".leases", ".trash", ".locks", ".upload-reservations", ".tiers"):
            _mkdir(self.root / name)

    def _current_mount(self):
        if self.mount_point is None or (self.mount_point == Path("/data2") and self.root == Path("/data2/datasets")):
            return _data2_mount()
        return _storage_mount(self.mount_point, self.root)

    @contextlib.contextmanager
    def _lock_file(self, name):
        if self.mount is not None and self._current_mount() != self.mount:
            raise CacheError("data mount identity changed; reopen cache after administrator verification")
        with _directory(self.root) as root, _directory(self.root / Path(name).parent) as parent:
            if (os.fstat(root).st_dev, os.fstat(root).st_ino) != self._root_identity:
                raise CacheError("cache directory identity changed; reopen after administrator verification")
            if self.mount is not None and os.fstat(root).st_dev != self.mount[2]:
                raise CacheError("cache no longer resides on the verified data mount")
            if os.fstat(parent).st_dev != os.fstat(root).st_dev:
                raise CacheError("cache lock directory is on a different filesystem")
            fd = os.open(Path(name).name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
            try:
                _regular(fd)
                deadline = time.monotonic() + self.lock_timeout
                while True:
                    try:
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            raise CacheBusy("dataset cache is busy; retry later without assuming READY")
                        time.sleep(min(0.025, max(0, deadline - time.monotonic())))
                yield
            finally:
                os.close(fd)

    def _locked(self):
        return self._lock_file(".lock")

    @contextlib.contextmanager
    def _version_locked(self, actor, dataset, version, *, snapshot=False):
        _identifier(dataset)
        _identifier(version, HASH_RE)
        # Authenticate before creating lock files; guessed IDs must not consume
        # arbitrary filesystem entries. Recheck authorization inside the caller.
        record, identity = self._record_snapshot(actor, dataset, version)
        with self._lock_file(".locks/" + dataset + "." + version + ".lock"):
            with self._locked():
                self._check_snapshot(actor, dataset, version, identity)
            if not snapshot:
                record = None  # Do not retain a second large manifest in legacy callers.
            yield (record, identity) if snapshot else None

    def _actor(self, actor, admin=False):
        if not isinstance(actor, Principal) or type(actor.is_admin) is not bool:
            raise CacheError("trusted Principal required")
        _identifier(actor.user_id, USER_RE)
        if admin and not actor.is_admin:
            raise PermissionError("administrator authorization required")

    def _paths(self, dataset, version=None):
        _identifier(dataset)
        if version is not None:
            _identifier(version, HASH_RE)
        return {name: self.root / name / dataset / version if version else self.root / name / dataset
                for name in (".registry", ".staging", "ready", ".leases")}

    def _dataset(self, actor, dataset):
        self._actor(actor)
        metadata = _read_json(self._paths(dataset)[".registry"] / "dataset.json")
        if (not isinstance(metadata, dict) or set(metadata) != {"schema", "owners"}
                or metadata["schema"] != SCHEMA):
            raise CacheError("corrupt dataset authorization metadata")
        self._owners(metadata["owners"])
        if not actor.is_admin and actor.user_id not in metadata["owners"]:
            raise PermissionError("dataset owner authorization required")
        return metadata

    @staticmethod
    def _owners(owners):
        if not isinstance(owners, list) or not owners or len(owners) > 10000:
            raise CacheError("at least one dataset owner is required")
        return sorted(set(_identifier(owner, USER_RE) for owner in owners))

    def _record(self, actor, dataset, version):
        self._dataset(actor, dataset)
        record = _read_json(self._paths(dataset)[".registry"] / (version + ".json")) if _identifier(version, HASH_RE) else None
        if (not isinstance(record, dict) or set(record) != {"schema", "manifest", "sourceId"}
                or record["schema"] != SCHEMA):
            raise CacheError("corrupt version registration")
        _, canonical = _manifest_bytes(record["manifest"])
        if hashlib.sha256(canonical).hexdigest() != version:
            raise CacheError("corrupt version registration")
        if record["sourceId"] is not None:
            _identifier(record["sourceId"])
        return record

    def _record_identity(self, dataset, version):
        filename = self._paths(dataset)[".registry"] / (_identifier(version, HASH_RE) + ".json")
        with _directory(filename.parent) as parent:
            fd = os.open(filename.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                return _stamp(_regular(fd))
            finally:
                os.close(fd)

    def _check_snapshot(self, actor, dataset, version, identity):
        # Authorization may be revoked while a long copy owns the version lock.
        # Revalidate the small owner record and immutable registration identity,
        # not a potentially 64 MiB manifest, under the global lock each batch.
        self._dataset(actor, dataset)
        if self._record_identity(dataset, version) != identity:
            raise CacheError("version registration changed; retry the operation")

    def _record_snapshot(self, actor, dataset, version):
        """Validate a full immutable manifest without owning the global lock.

        The service-owned registration can only be accepted if the same no-follow
        regular file still exists at the final locked authorization check. Nothing
        is persisted or trusted from an unvalidated summary. A replacement, even
        byte-identical, invalidates this operation rather than silently switching
        an in-flight reader or materializer to a different registration.
        """
        with self._locked():
            self._dataset(actor, dataset)
            identity = self._record_identity(dataset, version)
        record = self._record(actor, dataset, version)
        with self._locked():
            self._check_snapshot(actor, dataset, version, identity)
        return record, identity

    def _version_entry_exists(self, path):
        """Inspect a required dataset parent without recreating or following it.

        A missing version is normal; a missing parent is incomplete storage
        metadata, not proof that a registered replica is safe to prepare.
        """
        try:
            with _directory(path.parent) as fd:
                return path.name in os.listdir(fd)
        except FileNotFoundError:
            raise CacheError("dataset storage metadata is incomplete; administrator verification required") from None

    def _ready_identity(self, paths):
        """Small no-follow identities only; never parse a READY manifest here."""
        try:
            with _directory(paths["ready"]) as fd:
                wrapper = _stamp(os.fstat(fd))
                files = []
                for name in ("READY.json", "manifest.json"):
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        files.append(_stamp(_regular(child)))
                    finally:
                        os.close(child)
            with _directory(paths["ready"] / "data") as fd:
                return wrapper, tuple(files), _stamp(os.fstat(fd))
        except FileNotFoundError:
            if self._version_entry_exists(paths["ready"]):
                raise CacheError("published directory has no valid READY metadata")
            return None

    def _ready_snapshot(self, paths, manifest, version):
        # Every caller has just obtained this manifest from _record_snapshot or
        # a version-locked validated registration. Keep that full validation;
        # compare READY canonical bytes to its version rather than parse a
        # second large object. Identity checks still bracket the complete read.
        identity = self._ready_identity(paths)
        ready = self._ready(paths, manifest, version, _canonical=True)
        if self._ready_identity(paths) != identity:
            raise CacheError("published version metadata changed; retry the operation")
        return ready, identity

    def _check_ready_snapshot(self, paths, identity):
        if self._ready_identity(paths) != identity:
            raise CacheError("published version metadata changed; retry the operation")

    def _free(self, needed=0, needed_inodes=0):
        with _directory(self.root) as fd:
            info = os.fstatvfs(fd)
        if info.f_bavail * info.f_frsize < self.reserve_bytes + needed:
            raise CacheError("insufficient free space including safety reserve; no publication allowed")
        if getattr(info, 'f_files', 0) > 0 and info.f_favail < 1024 + needed_inodes + self._upload_reserved()[1]:
            raise CacheError("insufficient free inodes including upload reservations")

    def _register(self, actor, dataset, manifest, owners, source_id):
        self._actor(actor, admin=True)
        owners = self._owners(owners)
        manifest = _manifest(manifest)
        version = _version(manifest)
        paths = self._paths(dataset)
        self._free(self._reserved() + len(_json_bytes(manifest)) + 8192)
        for path in paths.values():
            _mkdir(path)
        try:
            current = self._dataset(actor, dataset)
            if current["owners"] != owners:
                raise CacheError("use set_owners explicitly to change dataset authorization")
        except FileNotFoundError:
            _write_json(paths[".registry"] / "dataset.json", dict(schema=SCHEMA, owners=owners))
        filename = paths[".registry"] / (version + ".json")
        record = dict(schema=SCHEMA, manifest=manifest, sourceId=source_id)
        try:
            existing = self._record(actor, dataset, version)
        except FileNotFoundError:
            # New/re-registered content is never implicitly disposable, even
            # when an earlier registration left a recovery receipt behind.
            if self._tier(dataset, version)["pins"]:
                raise CacheError("orphan persistent pins require administrator reconciliation")
            self._write_tier(dataset, version, self._default_tier())
            _write_json(filename, record)
        else:
            if existing["manifest"] != manifest:
                raise CacheError("registered version is immutable")
            if existing["sourceId"] is None and source_id is not None:
                if self._authority_pins(dataset, version):
                    raise CacheError("authority retention prevents source changes; reconcile dependents first")
                _write_json(filename, record)
            elif source_id is not None and existing["sourceId"] != source_id:
                raise CacheError("registered source is immutable")
        return dict(dataset=dataset, version=version, bytes=sum(f["size"] for f in manifest["files"]), files=len(manifest["files"]))

    def register_source(self, actor, dataset, source_id, owners):
        self._actor(actor, admin=True)
        _identifier(dataset)
        self._owners(owners)
        _identifier(source_id)
        if source_id not in self.sources:
            raise PermissionError("source ID has not been approved in administrator configuration")
        manifest = _scan(self.sources[source_id])
        with self._locked():
            return self._register(actor, dataset, manifest, owners, source_id)

    def register_manifest(self, actor, dataset, manifest, owners):
        """Administrator imports a manifest delivered by a trusted source node."""
        with self._locked():
            return self._register(actor, dataset, manifest, owners, None)

    def attach_source(self, actor, dataset, version, source_id):
        """Bind an admin-trusted manifest to an approved source, without a tree scan.

        The caller authenticates the exported manifest. Materialization reads only
        its registered files and verifies the complete local result before READY.
        This supports a read-only LAN/NFS source without hashing it a second time.
        """
        self._actor(actor, admin=True)
        _identifier(source_id)
        if source_id not in self.sources:
            raise PermissionError("source ID has not been approved in administrator configuration")
        with self._locked():
            record = self._record(actor, dataset, version)
            if record["sourceId"] not in (None, source_id):
                raise CacheError("registered source is immutable")
            if self._authority_pins(dataset, version):
                if record["sourceId"] == source_id:
                    return dict(dataset=dataset, version=version, attached=True)
                raise CacheError("authority retention prevents source changes; reconcile dependents first")
            record["sourceId"] = source_id
            _write_json(self._paths(dataset)[".registry"] / (version + ".json"), record)
            return dict(dataset=dataset, version=version, attached=True)

    def set_owners(self, actor, dataset, owners):
        with self._locked():
            self._actor(actor, admin=True)
            existing = self._dataset(actor, dataset)
            owners = self._owners(owners)
            if existing["owners"] == owners:
                return {"updated": True}
            if self._authority_pins(dataset):
                raise CacheError("authority retention prevents ACL changes; reconcile dependents first")
            _write_json(self._paths(dataset)[".registry"] / "dataset.json", dict(schema=SCHEMA, owners=owners))
            return {"updated": True}

    def export_manifest(self, actor, dataset, version):
        record, identity = self._record_snapshot(actor, dataset, version)
        with self._locked():
            self._check_snapshot(actor, dataset, version, identity)
            return dict(dataset=dataset, version=version, manifest=record["manifest"])

    def capacity(self, actor):
        """Constant-time filesystem snapshot, not a per-user hard quota.

        No manifests or data trees are scanned. usableBytes subtracts the
        configured safety reserve only; admission still checks in-flight
        reservations under its own lock when a transfer actually begins.
        """
        self._actor(actor)
        with self._locked(), _directory(self.root) as fd:
            info = os.fstatvfs(fd)
            block = info.f_frsize or info.f_bsize
            available = max(0, info.f_bavail) * block
            inodes_known = info.f_files > 0 and 0 <= info.f_favail <= info.f_files
            return dict(filesystemBytes=info.f_blocks * block,
                        usedBytes=max(0, info.f_blocks - info.f_bfree) * block,
                        availableBytes=available, reserveBytes=self.reserve_bytes,
                        usableBytes=max(0, available - self.reserve_bytes),
                        totalInodes=info.f_files if inodes_known else None,
                        availableInodes=info.f_favail if inodes_known else None,
                        inodeUsageKnown=inodes_known, guarded=self.mount is not None,
                        scope="filesystem", activeReservationsIncluded=False)

    def list_datasets(self, actor):
        """Authorized catalog and bounded ACL owner IDs, never source IDs/paths."""
        return self._list_datasets_snapshot(actor)[0]

    def _catalog_binding(self, dataset, version):
        """Metadata-only key for a display summary, never an admission proof."""
        def stamp(info):
            return [info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                    info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns]
        paths = self._paths(dataset, version)
        filename = paths['.registry'].parent / (version + '.json')
        with _directory(filename.parent) as parent:
            folder = stamp(os.fstat(parent))
            fd = os.open(filename.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                record = stamp(_regular(fd))
            finally:
                os.close(fd)
        ready = None
        try:
            with _directory(paths['ready']) as fd:
                ready = [stamp(os.fstat(fd))]
                for name in ('READY.json', 'manifest.json'):
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        ready.append(stamp(_regular(child)))
                    finally:
                        os.close(child)
            with _directory(paths['ready'] / 'data') as fd:
                ready.append(stamp(os.fstat(fd)))
        except FileNotFoundError:
            if self._version_entry_exists(paths['ready']):
                raise CacheError('published directory has no valid READY metadata')
            ready = None
        return dict(root=list(self._root_identity), dataset=dataset, version=version,
                    folder=folder, record=record, ready=ready)

    def _catalog_directory(self):
        path = self.root / '.catalog'
        _mkdir(path)
        with _directory(path) as fd:
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise CacheError('unsafe derived catalog directory')
        return path

    def _catalog_summary(self, binding, value=None):
        """Bounded service-private, disposable display cache; failure is a miss.

        No manifest or source path is retained. Source capability is recomputed
        from the current configuration. Leases, status and all data operations
        never consume these summaries.
        """
        try:
            directory = self._catalog_directory()
            name = hashlib.sha256((binding['dataset'] + '\0' + binding['version']).encode()).hexdigest() + '.json'
            path = directory / name
            if value is not None:
                with _directory(directory) as parent:
                    names = os.listdir(parent)
                    if any(not re.fullmatch(r'[a-f0-9]{64}\.json', item) for item in names):
                        return None
                    if name not in names and len(names) >= CATALOG_SUMMARY_ROWS:
                        return None
                _write_json(path, dict(schema=SCHEMA, binding=binding, summary=value))
                return None
            with _directory(directory) as parent:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    before = _regular(fd)
                    if (before.st_uid != os.geteuid() or stat.S_IMODE(before.st_mode) != 0o600
                            or before.st_size > CATALOG_SUMMARY_BYTES):
                        return None
                    raw = os.read(fd, CATALOG_SUMMARY_BYTES + 1)
                    if (len(raw) != before.st_size or _stamp(before) != _stamp(_regular(fd))
                            or _stamp(before) != _stamp(os.stat(name, dir_fd=parent, follow_symlinks=False))):
                        return None
                    value = json.loads(raw)
                finally:
                    os.close(fd)
            if (not isinstance(value, dict) or set(value) != {'schema', 'binding', 'summary'}
                    or type(value['schema']) is not int or value['schema'] != SCHEMA
                    or _json_bytes(value['binding']) != _json_bytes(binding)):
                return None
            row = value['summary']
            if (not isinstance(row, dict) or set(row) != {'bytes', 'files', 'ready', 'sourceId'}
                    or type(row['bytes']) is not int or not 0 <= row['bytes'] <= MAX_ENTRIES * (2**63 - 1)
                    or type(row['files']) is not int or not 0 <= row['files'] <= MAX_ENTRIES
                    or type(row['ready']) is not bool or row['ready'] != (binding['ready'] is not None)):
                return None
            if row['sourceId'] is not None:
                _identifier(row['sourceId'])
            return row
        except (OSError, CacheError, ValueError, TypeError, KeyError):
            return None

    def _catalog_version(self, actor, dataset, version):
        with self._locked():
            self._dataset(actor, dataset)
            binding = self._catalog_binding(dataset, version)
            summary = self._catalog_summary(binding)
            if summary is not None:
                identity = self._record_identity(dataset, version)
                ready_identity = self._ready_identity(self._paths(dataset, version))
                if self._catalog_binding(dataset, version) != binding:
                    raise CacheError('catalog metadata changed; retry the operation')
                return summary, identity, ready_identity, binding
        record, identity = self._record_snapshot(actor, dataset, version)
        ready, ready_identity = self._ready_snapshot(self._paths(dataset, version), record['manifest'], version)
        summary = dict(bytes=sum(f['size'] for f in record['manifest']['files']),
                       files=len(record['manifest']['files']), ready=ready, sourceId=record['sourceId'])
        with self._locked():
            self._check_snapshot(actor, dataset, version, identity)
            self._check_ready_snapshot(self._paths(dataset, version), ready_identity)
            if self._catalog_binding(dataset, version) != binding:
                raise CacheError('catalog metadata changed; retry the operation')
            self._catalog_summary(binding, summary)
        return summary, identity, ready_identity, binding

    def _list_datasets_snapshot(self, actor):
        """Private per-request identities for a detached-worker status overlay.

        A bounded service-owned display summary may avoid reparsing unchanged
        manifests. Each call checks live ACL and all registration/READY stamps;
        a miss uses the original full validation. Data admission never uses it.
        """
        self._actor(actor)
        snapshots = []
        with self._locked():
            with _directory(self.root / ".registry") as fd:
                datasets = sorted(os.listdir(fd))
        for dataset in datasets:
            with self._locked():
                try:
                    self._dataset(actor, dataset)
                except PermissionError:
                    continue
                folder = self._paths(dataset)[".registry"]
                with _directory(folder) as fd:
                    names = sorted(os.listdir(fd))
            versions = []
            for name in names:
                if name == "dataset.json" or re.fullmatch(r"\.write-[a-f0-9]{32}", name):
                    continue
                if not name.endswith(".json"):
                    raise CacheError("corrupt registry directory")
                version = name[:-5]
                summary, identity, ready_identity, binding = self._catalog_version(actor, dataset, version)
                # Summation and parsing scale with the manifest; they must not
                # delay unrelated publication/lease admission under global lock.
                row = dict(version=version, state="READY" if summary['ready'] else "REGISTERED",
                           canPrepare=summary['sourceId'] in self.sources,
                           bytes=summary['bytes'], files=summary['files'])
                versions.append((row, identity, ready_identity, binding))
            snapshots.append((dataset, versions))
        result, current = [], {}
        with self._locked():
            for dataset, versions in snapshots:
                # Recheck every ACL before any catalog leaves the service. ACL
                # revocation or metadata replacement during parsing is rejected.
                metadata = self._dataset(actor, dataset)
                rows = []
                for row, identity, ready_identity, binding in versions:
                    version = row['version']
                    self._check_snapshot(actor, dataset, version, identity)
                    paths = self._paths(dataset, version)
                    self._check_ready_snapshot(paths, ready_identity)
                    if self._catalog_binding(dataset, version) != binding:
                        raise CacheError('catalog metadata changed; retry the operation')
                    current[(dataset, version)] = (identity, ready_identity,
                                                  row['state'] == 'READY', row['bytes'])
                    if row['state'] != "READY" and self._version_entry_exists(paths[".staging"]):
                        row['state'] = "STAGING"
                    rows.append(row)
                owners = self._owners(metadata["owners"])
                # A display bound, not an ACL limit. Never return a truncated
                # list that could be mistaken for the complete authorization.
                result.append(dict(dataset=dataset, versions=rows,
                                   ownerIds=owners if len(owners) <= 64 else None))
        return {"datasets": result}, current

    def status(self, actor, dataset, version):
        """Lightweight metadata only: no data hashing or staging modifications."""
        return self._status_snapshot(actor, dataset, version)[0]

    def _status_snapshot(self, actor, dataset, version):
        """Trusted adapter also receives the validated registration identity."""
        try:
            record, identity = self._record_snapshot(actor, dataset, version)
        except FileNotFoundError:
            # Keep the missing-registration type for internal lifecycle callers,
            # but never expose an OS path as the user's status explanation.
            raise FileNotFoundError("dataset registration or version does not exist or was removed; refresh the dataset list") from None
        paths = self._paths(dataset, version)
        ready, ready_identity = self._ready_snapshot(paths, record["manifest"], version)
        remaining = 0 if ready else sum(f["size"] for f in record["manifest"]["files"])
        return self._status_catalog_snapshot(actor, dataset, version,
                                             (identity, ready_identity, ready, remaining)), identity

    def _status_catalog_snapshot(self, actor, dataset, version, snapshot):
        """Trusted same-call catalog snapshot; never a public request field."""
        identity, ready_identity, ready, remaining = snapshot
        paths = self._paths(dataset, version)
        state = "READY" if ready else "REGISTERED"
        remaining = 0 if ready else remaining
        with self._locked():
            self._check_snapshot(actor, dataset, version, identity)
            self._check_ready_snapshot(paths, ready_identity)
            if state != "READY" and self._version_entry_exists(paths[".staging"]):
                state = "STAGING"
                remaining = self._transfer(paths[".staging"])["remainingBytes"]
            return dict(dataset=dataset, version=version, state=state, remainingBytes=remaining)

    def _transfer(self, stage):
        value = _read_json(stage / "TRANSFER.json")
        if (not isinstance(value, dict) or set(value) != {"schema", "owner", "token", "remainingBytes", "totalBytes"}
                or value["schema"] != SCHEMA or type(value["remainingBytes"]) is not int
                or type(value["totalBytes"]) is not int or not 0 <= value["remainingBytes"] <= value["totalBytes"]):
            raise CacheError("corrupt transfer fence; administrator repair required")
        _identifier(value["owner"], USER_RE)
        if not isinstance(value["token"], str) or str(uuid.UUID(value["token"])) != value["token"]:
            raise CacheError("invalid transfer token")
        return value

    def _upload_reserved(self):
        total = inodes = 0
        # Member uploads reserve future payload before their large manifest is
        # sealed. Public-source materialization must see those reservations too.
        with _directory(self.root / ".upload-reservations") as fd:
            reservations = os.listdir(fd)
        for name in reservations:
            if re.fullmatch(r"\.write-[a-f0-9]{32}", name):
                continue
            if not re.fullmatch(r"[a-f0-9]{64}\.json", name):
                raise CacheError("corrupt upload reservation directory")
            value = _read_json(self.root / ".upload-reservations" / name)
            if (not isinstance(value, dict) or set(value) not in ({"bytes"}, {"bytes", "inodes"})
                    or any(type(number) is not int or not 0 <= number <= 2**63-1 for number in value.values())):
                raise CacheError("corrupt upload reservation")
            total += value["bytes"]
            inodes += value.get('inodes', 0)
        return total, inodes

    def _reserved(self, except_stage=None):
        total = self._upload_reserved()[0]
        with _directory(self.root / ".staging") as fd:
            datasets = os.listdir(fd)
        for dataset in datasets:
            _identifier(dataset)
            parent = self._paths(dataset)[".staging"]
            with _directory(parent) as fd:
                versions = os.listdir(fd)
            for version in versions:
                stage = self._paths(dataset, version)[".staging"]
                if stage != except_stage:
                    total += self._transfer(stage)["remainingBytes"]
        return total

    def _ready(self, paths, manifest, version, *, _canonical=False):
        try:
            marker = _read_json(paths["ready"] / "READY.json")
        except FileNotFoundError:
            if self._version_entry_exists(paths["ready"]):
                raise CacheError("published directory has no valid READY marker")
            return False
        if marker != {"schema": SCHEMA, "version": version}:
            raise CacheError("published version metadata is corrupt")
        matches = (_canonical_json_matches(paths["ready"] / "manifest.json", version)
                   if _canonical else _read_json(paths["ready"] / "manifest.json") == manifest)
        if not matches:
            raise CacheError("published version metadata is corrupt")
        with _directory(paths["ready"]) as fd:
            if os.fstat(fd).st_mode & 0o222:
                raise CacheError("published version wrapper is not read-only")
        with _directory(paths["ready"] / "data") as fd:
            if os.fstat(fd).st_mode & 0o222:
                raise CacheError("published data is not read-only")
        return True

    def _stage_files(self, stage, manifest, *, hashes=True, index=None):
        wanted = index if index is not None else {f["path"]: f for f in manifest["files"]}
        expected_dirs = set(manifest["directories"])
        found = {}
        def visit(fd, prefix):
            for name in os.listdir(fd):
                relative = _relative(prefix + name)
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    if relative not in expected_dirs:
                        raise CacheError("unexpected staging directory")
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        visit(child, relative + "/")
                    finally:
                        os.close(child)
                else:
                    if relative not in wanted:
                        raise CacheError("unexpected staging file")
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        size = _regular(child).st_size
                        if size > wanted[relative]["size"]:
                            raise CacheError("staging file exceeds registered size")
                        digest = _digest_fd(child)[0] if hashes else None
                        if hashes and size == wanted[relative]["size"] and digest != wanted[relative]["sha256"]:
                            raise CacheError("completed staging file checksum mismatch")
                        found[relative] = (size, digest)
                    finally:
                        os.close(child)
        with _directory(stage / "data") as fd:
            visit(fd, "")
        result = []
        empty_digest = hashlib.sha256(b"").hexdigest() if hashes else None
        for entry in manifest["files"]:
            size, digest = found.get(entry["path"], (0, empty_digest))
            result.append(dict(**entry, offset=size, prefixSha256=digest, complete=entry["path"] in found and size == entry["size"]))
        return result

    def _plan(self, actor, dataset, version, *, record=None, index=None):
        record = self._record(actor, dataset, version) if record is None else record
        paths = self._paths(dataset, version)
        manifest = record["manifest"]
        if self._ready(paths, manifest, version):
            return dict(dataset=dataset, version=version, state="READY", files=[], remainingBytes=0)
        stage = paths[".staging"]
        total = sum(f["size"] for f in manifest["files"])
        try:
            transfer = self._transfer(stage)
        except FileNotFoundError:
            with _directory(stage.parent) as fd:
                if stage.name in os.listdir(fd):
                    raise CacheError("incomplete transfer fence; administrator repair required")
            self._free(self._reserved() + total + 8192)
            _mkdir(stage)
            if getattr(self, 'quota_guard', None):
                try:
                    self.quota_guard(actor, dataset, stage)
                except Exception:
                    # No payload/fence has been written. Remove only our empty
                    # directory, never an unknown or retained transfer tree.
                    try: stage.rmdir()
                    except OSError: pass
                    raise
            _mkdir(stage / "data")
            transfer = dict(schema=SCHEMA, owner=actor.user_id, token=str(uuid.uuid4()), remainingBytes=total, totalBytes=total)
            _write_json(stage / "TRANSFER.json", transfer)
        if not actor.is_admin and transfer["owner"] != actor.user_id:
            raise PermissionError("unfinished transfer belongs to another owner")
        if getattr(self, 'quota_guard', None):
            self.quota_guard(actor, dataset, stage)
        if transfer["totalBytes"] != total:
            raise CacheError("transfer size differs from registered manifest")
        # Recover a crash between fsync of data and accounting update conservatively.
        files = self._stage_files(stage, manifest, hashes=False, index=index)
        remaining = sum(f["size"] - f["offset"] for f in files)
        self._free(self._reserved(except_stage=stage) + remaining + 8192)
        with _directory(stage) as fd:
            os.fchmod(fd, 0o700)
        transfer["remainingBytes"] = remaining
        _write_json(stage / "TRANSFER.json", transfer)
        return dict(dataset=dataset, version=version, state="STAGING", token=transfer["token"],
                    remainingBytes=remaining, chunkBytes=CHUNK_BYTES, files=files)

    def plan(self, actor, dataset, version):
        with self._version_locked(actor, dataset, version):
            with self._locked():
                result = self._plan(actor, dataset, version)
                manifest = self._record(actor, dataset, version)["manifest"]
            if result["state"] == "STAGING":
                result["files"] = self._stage_files(self._paths(dataset, version)[".staging"], manifest)
            return result

    def prepare_transfer(self, actor, dataset, version):
        """Privileged rsync integration only; stop/join writers before publish."""
        self._actor(actor, admin=True)
        plan = self.plan(actor, dataset, version)
        if plan["state"] == "STAGING":
            plan["stagingPath"] = str(self._paths(dataset, version)[".staging"] / "data")
            plan["transportRequirement"] = "trusted exclusive writer; no symlinks/devices/specials; exit before publish"
        return plan

    def _authorize_transfer(self, actor, dataset, version, token, *, snapshot=None):
        if snapshot is None:
            record = self._record(actor, dataset, version)
        else:
            record, identity = snapshot
            self._check_snapshot(actor, dataset, version, identity)
        paths = self._paths(dataset, version)
        if self._ready(paths, record["manifest"], version):
            raise CacheError("published version cannot be modified")
        transfer = self._transfer(paths[".staging"])
        if transfer["token"] != token or (not actor.is_admin and transfer["owner"] != actor.user_id):
            raise PermissionError("transfer owner/token mismatch")
        return record, paths, transfer

    def put_chunk(self, actor, dataset, version, path, offset, data, token):
        if type(offset) is not int or offset < 0 or not isinstance(data, bytes) or len(data) > CHUNK_BYTES:
            raise CacheError("invalid chunk offset/data/size")
        _relative(path)
        with self._version_locked(actor, dataset, version, snapshot=True) as snapshot:
            with self._locked():
                record, paths, transfer = self._authorize_transfer(actor, dataset, version, token, snapshot=snapshot)
                entry = next((f for f in record["manifest"]["files"] if f["path"] == path), None)
                if entry is None:
                    raise CacheError("chunk outside registered file")
                self._free(self._reserved() + 8192)
                result, written = self._put_chunk_data(paths[".staging"], entry, offset, data, transfer["remainingBytes"])
                if written:
                    transfer["remainingBytes"] -= written
                    _write_json(paths[".staging"] / "TRANSFER.json", transfer)
                return result

    def _put_chunk_data(self, stage, entry, offset, data, remaining):
        """Validated manifest entry, exclusive version lock, reserved capacity.

        Data and directory entries reach disk before callers reduce accounting.
        A crash before the batched fence update thus only over-reserves space;
        _plan recovers from actual file sizes and verifies prefixes before resume.
        """
        if offset + len(data) > entry["size"]:
            raise CacheError("chunk outside registered file")
        path = entry["path"]
        parent = stage / "data"
        for part in Path(path).parts[:-1]:
            parent = parent / part
            _mkdir(parent)
        with _directory(parent) as fd:
            target = os.open(Path(path).name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
            try:
                size = _regular(target).st_size
                if offset < size and offset + len(data) <= size:
                    os.lseek(target, offset, os.SEEK_SET)
                    if os.read(target, len(data)) != data:
                        raise CacheError("retry would overwrite existing bytes")
                    return dict(offset=size, complete=size == entry["size"]), 0
                if offset != size:
                    raise CacheError("chunk offset must match current file length")
                if remaining < len(data):
                    raise CacheError("invalid transfer space accounting")
                os.lseek(target, offset, os.SEEK_SET)
                view = memoryview(data)
                while view:
                    written = os.write(target, view)
                    if not written:
                        raise OSError("short dataset write")
                    view = view[written:]
                os.fsync(target)
                os.fsync(fd)
            finally:
                os.close(target)
        return dict(offset=offset + len(data), complete=offset + len(data) == entry["size"]), len(data)

    def read_chunk(self, actor, dataset, version, path, offset=0, length=CHUNK_BYTES):
        """Only registered paths from a published replica, never arbitrary host files."""
        _relative(path)
        if type(offset) is not int or offset < 0 or type(length) is not int or not 1 <= length <= CHUNK_BYTES:
            raise CacheError("invalid read range")
        with self._locked():
            record = self._record(actor, dataset, version)
            paths = self._paths(dataset, version)
            if not self._ready(paths, record["manifest"], version):
                raise CacheError("dataset version is not READY")
            entry = next((f for f in record["manifest"]["files"] if f["path"] == path), None)
            if entry is None or offset > entry["size"]:
                raise CacheError("read outside registered file")
            filename = paths["ready"] / "data" / path
            with _directory(filename.parent) as parent:
                fd = os.open(filename.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    if _regular(fd).st_size != entry["size"]:
                        raise CacheError("published file size changed")
                    os.lseek(fd, offset, os.SEEK_SET)
                    data = os.read(fd, length)
                finally:
                    os.close(fd)
            return dict(data=base64.b64encode(data).decode(), offset=offset + len(data), eof=offset + len(data) == entry["size"])

    def publish(self, actor, dataset, version, token):
        with self._version_locked(actor, dataset, version, snapshot=True) as snapshot:
            return self._publish_locked(actor, dataset, version, token, snapshot)

    def _publish_locked(self, actor, dataset, version, token, snapshot, *, _guard=None):
        """Publish with the same exclusively locked, validated registration."""
        record, identity = snapshot
        paths = self._paths(dataset, version)
        ready, ready_identity = self._ready_snapshot(paths, record["manifest"], version)
        with self._locked():
            if _guard is not None:
                _guard()
            self._check_snapshot(actor, dataset, version, identity)
            self._check_ready_snapshot(paths, ready_identity)
            if ready:
                return dict(dataset=dataset, version=version, state="READY")
            record, paths, transfer = self._authorize_transfer(actor, dataset, version, token, snapshot=snapshot)
            # Empty directories are real disk/inode allocations too. Reserve
            # their worst-case metadata before creating a large empty tree.
            self._free(self._reserved()+8192*len(record['manifest']['directories'])+8192,
                       needed_inodes=len(record['manifest']['directories']))
        stage = paths[".staging"]
        for directory in record["manifest"]["directories"]:
            _mkdir(stage / "data" / directory)
        actual = _scan(stage / "data")
        if actual != record["manifest"]:
            raise CacheError("staging checksum/tree does not match registered version")
        with self._locked():
            if _guard is not None:
                _guard()
            self._authorize_transfer(actor, dataset, version, token, snapshot=snapshot)
            self._free(self._reserved(except_stage=stage) + len(_json_bytes(actual)) + 8192)
            with _directory(stage) as fd:
                os.fchmod(fd, 0o700)
                names = set(os.listdir(fd))
            if not names <= {"data", "TRANSFER.json", "manifest.json", "READY.json"}:
                raise CacheError("unexpected staging metadata")
            _write_json(stage / "manifest.json", actual)
            _write_json(stage / "READY.json", dict(schema=SCHEMA, version=version))
        try:
            # Hashing and chmod/fsync hold only the version lock. Other versions
            # and lightweight status remain available throughout a long copy.
            _modes(stage, True)
            with self._locked():
                if _guard is not None:
                    _guard()
                self._authorize_transfer(actor, dataset, version, token, snapshot=snapshot)
                self._free(self._reserved(except_stage=stage) + 8192)
                with _directory(stage) as fd:
                    os.fchmod(fd, 0o700)
                    os.unlink("TRANSFER.json", dir_fd=fd)
                    os.fchmod(fd, 0o555)
                    os.fsync(fd)
                _rename_new(stage, paths["ready"])
        except BaseException:
            try:
                _modes(stage, False)
                _write_json(stage / "TRANSFER.json", transfer)
            except OSError:
                pass
            raise
        return dict(dataset=dataset, version=version, state="READY")

    def materialize(self, actor, dataset, version, *, _source=None, _guard=None):
        """Copy an approved source. Private overrides are trusted tier hooks only.

        dispatch never accepts _source/_guard; callers must not derive them from
        a user request. The tier adapter supplies a protected fixed READY path
        and checks its receipt while this method owns the destination version.
        """
        self._actor(actor)
        if _source is not None or _guard is not None:
            self._actor(actor, admin=True)
        with self._version_locked(actor, dataset, version, snapshot=True) as snapshot:
            record, identity = snapshot
            index = {entry["path"]: entry for entry in record["manifest"]["files"]}
            paths = self._paths(dataset, version)
            ready, ready_identity = self._ready_snapshot(paths, record["manifest"], version)
            with self._locked():
                if _guard is not None:
                    _guard()
                self._check_snapshot(actor, dataset, version, identity)
                self._check_ready_snapshot(paths, ready_identity)
                if ready:
                    return dict(dataset=dataset, version=version, state="READY")
                source = _absolute(_source) if _source is not None else self.sources.get(record["sourceId"])
                if source is None:
                    raise CacheError("version has no approved local source")
                plan = self._plan(actor, dataset, version, record=record, index=index)
                fence = self._transfer(paths[".staging"])
                del plan["files"]
            stage = paths[".staging"]
            files = self._stage_files(stage, record["manifest"], index=index)
            # The on-disk remainingBytes intentionally stays an upper bound
            # until fsynced chunks are checkpointed. Other versions can never
            # spend unaccounted capacity; a killed copy remains resumable.
            remaining = plan["remainingBytes"]
            batch_bytes = batch_files = 0
            checked_at = time.monotonic()

            def checkpoint():
                nonlocal fence, batch_bytes, batch_files, checked_at
                with self._locked():
                    if _guard is not None:
                        _guard()
                    _, _, current = self._authorize_transfer(actor, dataset, version, plan["token"], snapshot=snapshot)
                    if current != fence:
                        raise CacheError("transfer accounting changed during exclusive copy")
                    self._free(self._reserved(except_stage=stage) + remaining + 8192)
                    if current["remainingBytes"] != remaining:
                        fence = dict(current, remainingBytes=remaining)
                        _write_json(stage / "TRANSFER.json", fence)
                batch_bytes = batch_files = 0
                checked_at = time.monotonic()

            def put_reserved(entry, offset, data):
                # Keep live free-space/owner checks at chunk granularity. The
                # durable fence reserves this version's entire future write,
                # so releasing the global lock before local I/O cannot let
                # another admission spend this capacity. Avoid counting our
                # already-fsynced but not-yet-checkpointed bytes twice.
                with self._locked():
                    if _guard is not None:
                        _guard()
                    self._check_snapshot(actor, dataset, version, identity)
                    self._free(self._reserved(except_stage=stage) + remaining + 8192)
                return self._put_chunk_data(stage, entry, offset, data, remaining)

            checkpoint()
            for entry in files:
                filename = source / entry["path"]
                with _directory(filename.parent) as parent:
                    fd = os.open(filename.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                    try:
                        before = _regular(fd)
                        if before.st_size != entry["size"]:
                            raise CacheError("approved source size changed since registration")
                        if _digest_fd(fd, entry["offset"])[0] != entry["prefixSha256"]:
                            raise CacheError("partial transfer is not a prefix of the registered source")
                        offset = entry["offset"]
                        os.lseek(fd, offset, os.SEEK_SET)
                        if entry["size"] == 0 and not entry["complete"]:
                            put_reserved(index[entry["path"]], 0, b"")
                        while offset < entry["size"]:
                            data = os.read(fd, min(CHUNK_BYTES, entry["size"] - offset))
                            if not data:
                                raise CacheError("source changed during copy")
                            _, written = put_reserved(index[entry["path"]], offset, data)
                            remaining -= written
                            batch_bytes += written
                            offset += len(data)
                            if batch_bytes >= TRANSFER_BATCH_BYTES or time.monotonic() - checked_at >= TRANSFER_BATCH_SECONDS:
                                checkpoint()
                        if _stamp(before) != _stamp(_regular(fd)):
                            raise CacheError("source changed during copy")
                    finally:
                        os.close(fd)
                batch_files += 1
                if batch_files >= TRANSFER_BATCH_FILES or time.monotonic() - checked_at >= TRANSFER_BATCH_SECONDS:
                    checkpoint()
            checkpoint()
            # Full destination hashing is still mandatory before atomic READY;
            # source identity and resumed-prefix checks above remain unchanged.
            # The scan builds its own tree; do not retain a second full resume
            # plan and path index while hashing up to half a million files.
            del files, index
            return self._publish_locked(actor, dataset, version, plan["token"], snapshot, _guard=_guard)

    def prepare(self, actor, dataset, version):
        """Materialize an approved local source, or return a resumable replica plan."""
        record, identity = self._record_snapshot(actor, dataset, version)
        with self._locked():
            self._check_snapshot(actor, dataset, version, identity)
            local = record["sourceId"] in self.sources
        del record
        return self.materialize(actor, dataset, version) if local else self.plan(actor, dataset, version)

    def verify(self, actor, dataset, version):
        with self._version_locked(actor, dataset, version):
            with self._locked():
                record = self._record(actor, dataset, version)
                paths = self._paths(dataset, version)
                if not self._ready(paths, record["manifest"], version):
                    raise CacheError("dataset version is not READY")
            if _scan(paths["ready"] / "data") != record["manifest"]:
                raise CacheError("dataset is not READY or integrity verification failed")
            return dict(dataset=dataset, version=version, state="READY", verified=True)

    def _leases(self, dataset, version):
        folder = self._paths(dataset, version)[".leases"]
        try:
            with _directory(folder) as fd:
                names = os.listdir(fd)
        except FileNotFoundError:
            return []
        leases = []
        for name in names:
            if not name.endswith(".json") or str(uuid.UUID(name[:-5])) != name[:-5]:
                raise CacheError("corrupt lease directory; eviction forbidden")
            lease = _read_json(folder / name)
            if (not isinstance(lease, dict) or set(lease) != {"schema", "id", "owner", "jobId", "createdAt"}
                    or lease["schema"] != SCHEMA or lease["id"] != name[:-5]):
                raise CacheError("corrupt lease; eviction forbidden")
            _identifier(lease["owner"], USER_RE)
            _identifier(lease["jobId"], USER_RE)
            leases.append(lease)
        return leases

    def acquire_lease(self, actor, dataset, version, job_id):
        """Executor must validate job ownership before invoking this method."""
        _identifier(job_id, USER_RE)
        record, identity = self._record_snapshot(actor, dataset, version)
        paths = self._paths(dataset, version)
        ready, ready_identity = self._ready_snapshot(paths, record["manifest"], version)
        with self._locked():
            self._check_snapshot(actor, dataset, version, identity)
            self._check_ready_snapshot(paths, ready_identity)
            if not ready:
                raise CacheError("cannot lease an unready version")
            leases = self._leases(dataset, version)
            lease = next((l for l in leases if l["jobId"] == job_id and l["owner"] == actor.user_id), None)
            if lease is None:
                self._free(self._reserved() + 4096)
                _mkdir(paths[".leases"])
                lease = dict(schema=SCHEMA, id=str(uuid.uuid4()), owner=actor.user_id, jobId=job_id, createdAt=time.time())
                _write_json(paths[".leases"] / (lease["id"] + ".json"), lease)
            self._touch_locked(dataset, version)
            return dict(leaseId=lease["id"], dataset=dataset, version=version, path=str(paths["ready"] / "data"), readOnly=True)

    def release_lease(self, actor, dataset, version, lease_id):
        """Trusted scheduler/admin only, AFTER confirming the job has stopped."""
        self._actor(actor, admin=True)
        if not isinstance(lease_id, str) or str(uuid.UUID(lease_id)) != lease_id:
            raise CacheError("invalid lease ID")
        _, identity = self._record_snapshot(actor, dataset, version)
        with self._locked():
            self._check_snapshot(actor, dataset, version, identity)
            leases = self._leases(dataset, version)
            if not any(l["id"] == lease_id for l in leases):
                return {"released": False}
            folder = self._paths(dataset, version)[".leases"]
            with _directory(folder) as fd:
                os.unlink(lease_id + ".json", dir_fd=fd)
                os.fsync(fd)
            return {"released": True}

    @staticmethod
    def _default_tier():
        return dict(schema=1, role="protected", lastUsedAt=0, pins={}, recovery=None)

    def _tier(self, dataset, version):
        """Private metadata; absence on an older registration means protected.

        Caller holds the global cache lock. This is separate from immutable
        manifests, so installing this feature never mutates their identity.
        """
        self._paths(dataset, version)
        try:
            value = _read_json(self.root / ".tiers" / dataset / (version + ".json"))
        except FileNotFoundError:
            return self._default_tier()
        if (not isinstance(value, dict) or set(value) != {"schema", "role", "lastUsedAt", "pins", "recovery"}
                or value["schema"] != 1 or value["role"] not in {"protected", "cache"}
                or type(value["lastUsedAt"]) not in (int, float)
                or not math.isfinite(value["lastUsedAt"]) or value["lastUsedAt"] < 0
                or not isinstance(value["pins"], dict)
                or (value["recovery"] is not None and not isinstance(value["recovery"], dict))):
            raise CacheError("corrupt tier metadata; cleanup forbidden")
        for key, pin in value["pins"].items():
            _identifier(key)
            if (not isinstance(pin, dict) or set(pin) != {"owner", "createdAt"}
                    or type(pin["createdAt"]) not in (int, float)
                    or not math.isfinite(pin["createdAt"]) or pin["createdAt"] < 0):
                raise CacheError("corrupt persistent pin; cleanup forbidden")
            _identifier(pin["owner"], USER_RE)
        return value

    def _write_tier(self, dataset, version, value):
        self._paths(dataset, version)
        folder = self.root / ".tiers" / dataset
        _mkdir(folder)
        _write_json(folder / (version + ".json"), value)

    def _authority_pins(self, dataset, version=None):
        """Permanent recovery retention freezes ACL/source identity as well.

        Caller holds global lock. These pins cannot be removed through ordinary
        unpin: decommission needs a separate trusted dependency reconciliation.
        Include orphan metadata so broken registration cannot erase retention.
        """
        self._paths(dataset, version)
        if version is None:
            try:
                with _directory(self.root / ".tiers" / dataset) as fd:
                    names = os.listdir(fd)
            except FileNotFoundError:
                return False
            versions = []
            for name in names:
                if re.fullmatch(r"\.write-[a-f0-9]{32}", name):
                    continue
                if not name.endswith(".json"):
                    raise CacheError("unknown tier metadata; retention reconciliation required")
                versions.append(_identifier(name[:-5], HASH_RE))
        else:
            versions = [version]
        return any(any(pin.startswith("authority-") for pin in self._tier(dataset, item)["pins"])
                   for item in versions)

    def _touch_locked(self, dataset, version):
        value = self._tier(dataset, version)
        value["lastUsedAt"] = max(value["lastUsedAt"], time.time())
        self._write_tier(dataset, version, value)

    def touch(self, actor, dataset, version):
        """Record a real authorized use; catalog/status polls do not refresh LRU."""
        with self._locked():
            record = self._record(actor, dataset, version)
            if not self._ready(self._paths(dataset, version), record["manifest"], version):
                raise CacheError("cannot touch an unready version")
            self._touch_locked(dataset, version)
            return dict(touched=True)

    def pin(self, actor, dataset, version, pin_id):
        """Trusted operator/worker protection, with no age-based expiry."""
        self._actor(actor, admin=True)
        _identifier(pin_id)
        with self._locked():
            record = self._record(actor, dataset, version)
            if not self._ready(self._paths(dataset, version), record["manifest"], version):
                raise CacheError("cannot pin an unready version")
            tier = self._tier(dataset, version)
            tier["pins"].setdefault(pin_id, dict(owner=actor.user_id, createdAt=time.time()))
            self._write_tier(dataset, version, tier)
            return dict(pinned=True, pinId=pin_id)

    def unpin(self, actor, dataset, version, pin_id):
        """Only after the trusted caller has confirmed the protected use ended."""
        self._actor(actor, admin=True)
        _identifier(pin_id)
        if pin_id.startswith("authority-"):
            raise CacheError("authority retention pins require explicit dependency reconciliation")
        with self._locked():
            self._record(actor, dataset, version)
            tier = self._tier(dataset, version)
            removed = tier["pins"].pop(pin_id, None) is not None
            self._write_tier(dataset, version, tier)
            return dict(unpinned=removed)

    def _quarantine_locked(self, dataset, version, *, ready_only=False):
        """Caller owns version + global locks; lease/pin admission is atomic."""
        if self._leases(dataset, version):
            raise CacheError("active leases prevent eviction; leases never expire automatically")
        if self._tier(dataset, version)["pins"]:
            raise CacheError("persistent pins prevent eviction; pins never expire automatically")
        quarantined = []
        for name in (("ready",) if ready_only else ("ready", ".staging")):
            path = self._paths(dataset, version)[name]
            with _directory(path.parent) as fd:
                if path.name not in os.listdir(fd):
                    continue
            with _directory(path):
                pass
            trash = self.root / ".trash" / uuid.uuid4().hex
            _rename_new(path, trash)
            quarantined.append(trash)
        return quarantined

    def _remove_quarantined(self, quarantined):
        for trash in quarantined:
            _modes(trash, False)
            shutil.rmtree(trash)
            with _directory(trash.parent) as fd:
                os.fsync(fd)

    def evict(self, actor, dataset, version):
        """Administrator cleanup only. Registration remains for later recreation."""
        self._actor(actor, admin=True)
        with self._version_locked(actor, dataset, version):
            with self._locked():
                self._record(actor, dataset, version)
                quarantined = self._quarantine_locked(dataset, version)
            # Once quarantined atomically, no new lease can see these paths.
            # Large recursive cleanup need not block status/other dataset jobs.
            self._remove_quarantined(quarantined)
            return dict(evicted=bool(quarantined), registrationRetained=True)

    def _unregister_snapshot(self, actor, dataset, version):
        """Small, no-follow metadata snapshot; caller holds the global lock."""
        paths = self._paths(dataset)
        copies = set()
        for name in ("ready", ".staging", ".leases"):
            try:
                with _directory(paths[name]) as fd:
                    names = os.listdir(fd)
                    info = os.fstat(fd)
                    if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                        raise CacheError("unsafe dataset cleanup directory")
            except FileNotFoundError:
                continue
            for item in names:
                _identifier(item, HASH_RE)
                if version is None or item == version:
                    with _directory(paths[name] / item) as fd:
                        info = os.fstat(fd)
                        if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                            raise CacheError("unsafe dataset cleanup directory")
                    # Empty lease folders survive release_lease; they are not
                    # consumers and must not turn an idempotent retry into an
                    # orphan-data error after the registration was archived.
                    if name != ".leases" or self._leases(dataset, item):
                        copies.add(item)
        try:
            with _directory(paths[".registry"]) as fd:
                info = os.fstat(fd)
                if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                    raise CacheError("unsafe dataset registration directory")
                names = sorted(os.listdir(fd))
                stamps, registered = [], []
                for name in names:
                    temporary = re.fullmatch(r"\.write-[a-f0-9]{32}", name)
                    if name != "dataset.json" and not temporary:
                        if not name.endswith(".json"):
                            raise CacheError("corrupt registry directory")
                        registered.append(_identifier(name[:-5], HASH_RE))
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        child_info = _regular(child)
                        if child_info.st_uid != os.geteuid() or child_info.st_mode & 0o022:
                            raise CacheError("unsafe dataset registration file")
                        if version is None or name in ("dataset.json", version + ".json"):
                            stamps.append((name, _stamp(child_info)))
                    finally:
                        os.close(child)
        except FileNotFoundError:
            if copies:
                raise CacheError("unregistered local replicas or leases require administrator repair")
            return None
        metadata = self._dataset(actor, dataset)
        if version is not None and version not in registered:
            if copies:
                raise CacheError("unregistered local replicas or leases require administrator repair")
            return None
        versions = sorted(copies | (set(registered) if version is None else {version}))
        return dict(registry=stamps, metadata=metadata, versions=versions)

    @staticmethod
    def _unregister_move_record(source, destination):
        """Atomic no-replace move for one registration file, never source data."""
        with _directory(source.parent) as source_fd, _directory(destination.parent) as destination_fd:
            child = os.open(source.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_fd)
            try:
                _regular(child)
                if os.fstat(source_fd).st_dev != os.fstat(destination_fd).st_dev:
                    raise CacheError("registration recovery must remain on the same filesystem")
                libc = ctypes.CDLL(None, use_errno=True)
                if sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
                    fn, flags = libc.renameat2, 1
                elif sys.platform == "darwin" and hasattr(libc, "renameatx_np"):
                    fn, flags = libc.renameatx_np, 4
                else:
                    raise CacheError("atomic no-replace rename unavailable on this platform")
                fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
                fn.restype = ctypes.c_int
                if fn(source_fd, os.fsencode(source.name), destination_fd, os.fsencode(destination.name), flags):
                    code = ctypes.get_errno()
                    raise OSError(code, os.strerror(code))
                os.fsync(destination_fd)
                os.fsync(source_fd)
            finally:
                os.close(child)

    def _unregister_transaction(self, dataset, version, snapshot):
        """Reuse interrupted cleanup, but never overwrite an archived registration."""
        parent = self.root / ".trash"
        with _directory(parent) as fd:
            names = sorted(os.listdir(fd))
        transaction, receipt = None, None
        for name in names:
            if not re.fullmatch(r"unregister-[a-f0-9]{32}", name):
                continue
            candidate = parent / name
            _mkdir(candidate)  # Also checks ownership, mode and symlinks.
            try:
                previous = _read_json(candidate / "REMOVAL.json")
            except FileNotFoundError:
                continue  # Crash before recording intent; never adopt unknown data.
            if (not isinstance(previous, dict) or previous.get("schema") != SCHEMA
                    or type(previous.get("unregistered")) is not bool):
                raise CacheError("corrupt dataset removal journal")
            if previous.get("dataset") != dataset or previous.get("version") != version or previous["unregistered"]:
                continue
            archived = candidate / "registration"
            try:
                with _directory(archived) as fd:
                    # A crash after the final rename already committed removal,
                    # even if updating REMOVAL.json did not complete.
                    committed = version is None or version + ".json" in os.listdir(fd)
            except FileNotFoundError:
                committed = False
            if not committed:
                transaction, receipt = candidate, previous
                break
        if transaction is None:
            transaction = parent / ("unregister-" + uuid.uuid4().hex)
            _mkdir(transaction)
            receipt = dict(schema=SCHEMA, dataset=dataset, version=version,
                           versions=[], createdAt=time.time(), unregistered=False)
        previous_versions = receipt.get("versions")
        if not isinstance(previous_versions, list):
            raise CacheError("corrupt dataset removal journal")
        receipt["versions"] = sorted(set(_identifier(v, HASH_RE) for v in previous_versions) | set(snapshot["versions"]))
        receipt["owners"] = snapshot["metadata"]["owners"]
        _write_json(transaction / "REMOVAL.json", receipt)
        _mkdir(transaction / "replicas")
        for name in ("ready", "staging"):
            _mkdir(transaction / "replicas" / name)
        if version is not None:
            _mkdir(transaction / "registration")
            _write_json(transaction / "registration" / "dataset.json", snapshot["metadata"])
        return transaction, receipt

    def _unregister_cleanup(self, transaction):
        """Remove only already-quarantined replicas; keep recovery metadata."""
        if not shutil.rmtree.avoids_symlink_attacks:
            raise CacheError("descriptor-safe recursive cleanup unavailable on this platform")

        def writable_directories(fd):
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise CacheError("unsafe quarantined dataset directory")
            for name in os.listdir(fd):
                child_info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(child_info.st_mode):
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        writable_directories(child)
                    finally:
                        os.close(child)
                elif not stat.S_ISREG(child_info.st_mode) or child_info.st_nlink != 1:
                    raise CacheError("quarantined files must be regular files with a single link")
            # Unlink needs a writable parent, not writable files. This private
            # tree is already fenced off and locked; syncing/chmodding every
            # soon-to-be-deleted file adds no recovery guarantee. A crash can
            # safely repeat this directory-only preparation on the next retry.
            os.fchmod(fd, stat.S_IMODE(info.st_mode) | stat.S_IWUSR)

        for name in ("ready", "staging"):
            parent = transaction / "replicas" / name
            with _directory(parent) as fd:
                versions = sorted(os.listdir(fd))
            for version in versions:
                _identifier(version, HASH_RE)
                trash = parent / version
                with _directory(trash) as fd:
                    writable_directories(fd)
                shutil.rmtree(trash)
                with _directory(parent) as fd:
                    os.fsync(fd)

    def unregister(self, actor, dataset, version=None, *, _guard=None):
        """Admin-only reversible registration removal after unleased eviction.

        Internal transfers and leases share these locks. As with evict/publish,
        administrators MUST stop/join any external trusted rsync writer first.
        Cleanup failures leave registration in place; retries resume the private
        cleanup journal. Original configured source directories are never touched.
        """
        self._actor(actor, admin=True)
        self._paths(dataset, version)
        with self._locked():
            if _guard is not None:
                _guard()
            initial = self._unregister_snapshot(actor, dataset, version)
        if initial is None:
            return dict(dataset=dataset, version=version, versions=[], unregistered=False,
                        registrationRetained=False, recoveryId=None)

        def recheck():
            if _guard is not None:
                _guard()
            current = self._unregister_snapshot(actor, dataset, version)
            if (current is None or current["registry"] != initial["registry"]
                    or set(current["versions"]) - set(initial["versions"])):
                raise CacheBusy("dataset registration changed during removal; retry after checking the catalog")
            for item in initial["versions"]:
                if self._leases(dataset, item):
                    raise CacheError("active leases prevent unregister; leases never expire automatically")
                if self._tier(dataset, item)["pins"]:
                    raise CacheError("persistent pins prevent unregister")

        with contextlib.ExitStack() as locks:
            # Never wait on a version lock while holding the global lock: active
            # materialize/publish need global metadata access before releasing it.
            for item in initial["versions"]:
                locks.enter_context(self._lock_file(".locks/" + dataset + "." + item + ".lock"))
            with self._locked():
                recheck()  # All leases checked before the first filesystem move.
                transaction, receipt = self._unregister_transaction(dataset, version, initial)
            self._unregister_cleanup(transaction)
            with self._locked():
                recheck()  # A lease may have arrived while cleaning an old journal.
                for item in initial["versions"]:
                    for name, bucket in (("ready", "ready"), (".staging", "staging")):
                        path = self._paths(dataset, item)[name]
                        try:
                            with _directory(path):
                                pass
                        except FileNotFoundError:
                            continue
                        _rename_new(path, transaction / "replicas" / bucket / item)
            # Recursive deletion never blocks unrelated dataset metadata calls.
            # Version locks keep these paths absent until the final registry move.
            self._unregister_cleanup(transaction)
            with self._locked():
                recheck()
                registry = self._paths(dataset)[".registry"]
                if version is None:
                    _rename_new(registry, transaction / "registration")
                else:
                    self._unregister_move_record(registry / (version + ".json"),
                                                 transaction / "registration" / (version + ".json"))
                receipt["unregistered"] = True
                _write_json(transaction / "REMOVAL.json", receipt)
            return dict(dataset=dataset, version=version, versions=receipt["versions"], unregistered=True,
                        registrationRetained=False, recoveryId=transaction.name)

    def dispatch(self, actor, request):
        """Strict JSON adapter; caller supplies the trusted Principal separately."""
        if not isinstance(request, dict) or not isinstance(request.get("op"), str):
            raise CacheError("invalid dataset request")
        definitions = {
            "list": (self.list_datasets, set()),
            "capacity": (self.capacity, set()),
            "register_source": (self.register_source, {"dataset", "sourceId", "owners"}),
            "register_manifest": (self.register_manifest, {"dataset", "manifest", "owners"}),
            "attach_source": (self.attach_source, {"dataset", "version", "sourceId"}),
            "set_owners": (self.set_owners, {"dataset", "owners"}),
            "export_manifest": (self.export_manifest, {"dataset", "version"}),
            "plan": (self.plan, {"dataset", "version"}),
            "status": (self.status, {"dataset", "version"}),
            "prepare": (self.prepare, {"dataset", "version"}),
            "prepare_transfer": (self.prepare_transfer, {"dataset", "version"}),
            "put_chunk": (self.put_chunk, {"dataset", "version", "path", "offset", "data", "token"}),
            "read_chunk": (self.read_chunk, {"dataset", "version", "path", "offset", "length"}),
            "publish": (self.publish, {"dataset", "version", "token"}),
            "materialize": (self.materialize, {"dataset", "version"}),
            "verify": (self.verify, {"dataset", "version"}),
            "acquire_lease": (self.acquire_lease, {"dataset", "version", "jobId"}),
            "release_lease": (self.release_lease, {"dataset", "version", "leaseId"}),
            "evict": (self.evict, {"dataset", "version"}),
            "unregister": (self.unregister, {"dataset", "version"} if "version" in request else {"dataset"}),
        }
        if request["op"] not in definitions:
            raise CacheError("unsupported dataset operation")
        function, fields = definitions[request["op"]]
        if set(request) != fields | {"op"}:
            raise CacheError("missing or unrecognized dataset request fields")
        args = {key: request[key] for key in fields}
        for key, replacement in (("sourceId", "source_id"), ("jobId", "job_id"), ("leaseId", "lease_id")):
            if key in args:
                args[replacement] = args.pop(key)
        if request["op"] == "put_chunk":
            if not isinstance(args["data"], str) or len(args["data"]) > ((CHUNK_BYTES + 2) // 3) * 4:
                raise CacheError("invalid encoded chunk size")
            try:
                args["data"] = base64.b64decode(args["data"], validate=True)
            except (ValueError, UnicodeError) as exc:
                raise CacheError("invalid base64 chunk") from exc
        return function(actor, **args)


def _operator_config(filename):
    if os.geteuid() != 0:
        raise PermissionError("dataset-cache CLI is root-only; use authenticated executor APIs for member operations")
    path = _absolute(filename)
    with _directory(path.parent) as parent:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = _regular(fd)
            if info.st_uid != 0 or info.st_mode & 0o077:
                raise PermissionError("dataset config must be root-owned mode 0600")
            if info.st_size > MAX_JSON_BYTES:
                raise CacheError("administrator dataset config too large")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                config = json.loads(stream.read(MAX_JSON_BYTES + 1))
        finally:
            os.close(fd)
    if not isinstance(config, dict) or set(config) - {"root", "mountPoint", "sources", "reserveBytes", "serviceUid", "serviceGid"}:
        raise CacheError("invalid administrator dataset config")
    if ("serviceUid" in config) != ("serviceGid" in config):
        raise CacheError("serviceUid and serviceGid must be supplied together")
    for key in ("serviceUid", "serviceGid"):
        if key in config and (type(config[key]) is not int or not 0 <= config[key] < 2**31):
            raise CacheError("invalid cache service identity")
    return config


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", required=True, help="root-owned mode-0600 administrator config")
    args = parser.parse_args(argv)
    try:
        config = _operator_config(args.config)
        raw = sys.stdin.buffer.read(MAX_JSON_BYTES + 1)
        if len(raw) > MAX_JSON_BYTES:
            raise CacheError("request too large")
        request = json.loads(raw)
        if "serviceUid" in config:
            os.setgroups([])
            os.setgid(config["serviceGid"])
            os.setuid(config["serviceUid"])
        cache = DatasetCache(config.get("root", "/data2/datasets"), sources=config.get("sources", {}),
                             reserve_bytes=config.get("reserveBytes", DEFAULT_RESERVE),
                             mount_point=config.get("mountPoint", "/data2"))
        result = cache.dispatch(Principal("local-admin", True), request)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return 0
    except (OSError, ValueError, TypeError, KeyError) as exc:
        # OSError filenames may contain private source paths; keep them out of output.
        message = os.strerror(exc.errno) if isinstance(exc, OSError) and exc.errno else str(exc)
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
