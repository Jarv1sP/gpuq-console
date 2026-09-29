#!/usr/bin/env python3
"""Fail-closed Slurm adapter foundation; not wired into the production executor.

The caller authenticates/authorizes the portal user, reserves their quota, and
stages a run directory and immutable image before calling ``submit``. Trusted
policy maps portal identities to distinct Linux users and permitted partitions
and QOS; request data never supplies a Unix identity or raw scheduler flags.

Requires a single local Slurm cluster, Pyxis/Enroot, accounting, and
AccountingStoreFlags=job_comment. Protect/back up the SQLite ledger and its
parent directory as service-owned state on the broker's local disk, not NFS.
All portal replicas must use that one broker/ledger, never independent copies.
Persist validate_job's resolved partition/QOS with the job before dispatch so
later changes to policy defaults cannot reinterpret an old request. Keep stable
user-to-Linux identity mappings while jobs exist, even after revoking grants.
This is at-most-once dispatch, not a
claim that sbatch provides an atomic idempotency key: an ambiguous submission
is reconciled by UUID + owner + fingerprint and NEVER blindly submitted again.
If both Slurm records and ledger evidence are lost, operator recovery is needed.

No daemon or scheduler is started by importing this module. The injected runner
is useful for deterministic tests; the default runner uses fixed argv, a clean
environment, and the configured non-root Linux identity. Logs/files/terminals,
GPU index discovery, data staging, and portal integration are deliberately not
implemented here. Unknown states retain the caller's resource reservation.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shlex
import sqlite3
import stat
import subprocess
from typing import Callable, Mapping


UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z")
TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
LINUX_USER = re.compile(r"[a-z_][a-z0-9_-]{0,31}\Z")
JOB_ID = re.compile(r"[1-9][0-9]{0,19}\Z")
TERMINAL = frozenset({"SUCCEEDED", "FAILED", "CANCELED"})
JOB_FIELDS = frozenset({"id", "userId", "username", "cards", "argv", "name", "minVramGiB", "partition", "qos"})
REQUIRED_FIELDS = frozenset({"id", "userId", "username", "cards", "argv", "name", "minVramGiB"})


class ValidationError(ValueError):
    """Untrusted request or trusted policy cannot be safely represented."""


class ReconciliationError(RuntimeError):
    """Slurm output is missing, ambiguous, or inconsistent with the ledger."""


def _token(value, label):
    if not isinstance(value, str) or not TOKEN.fullmatch(value):
        raise ValidationError("Invalid " + label)
    return value


def _path(value, label):
    if not isinstance(value, str) or not value.startswith("/") or value == "/":
        raise ValidationError(label + " must be an absolute non-root path")
    # Pyxis mount syntax uses commas/colons, Slurm filenames interpret percent.
    if any(c in value for c in "\0\r\n,:%") or str(PurePosixPath(value)) != value or ".." in PurePosixPath(value).parts:
        raise ValidationError("Invalid " + label)
    return value


def _integer(value, low, high, label):
    if type(value) is not int or not low <= value <= high:
        raise ValidationError("Invalid " + label)
    return value


@dataclass(frozen=True)
class UserPolicy:
    linux_user: str
    partitions: frozenset[str]
    qos: frozenset[str]


@dataclass(frozen=True)
class PartitionPolicy:
    """Operator-verified homogeneous GRES type and minimum card capacity."""

    gpu_type: str
    max_cards: int
    min_vram_gib: float
    cpus_per_gpu: int = 4
    memory_mib_per_gpu: int = 8192


@dataclass(frozen=True)
class Policy:
    users: Mapping[str, UserPolicy]
    partitions: Mapping[str, PartitionPolicy]
    qos: frozenset[str]
    default_partition: str
    default_qos: str
    run_root: str
    image: str
    time_minutes: int = 1440

    def __post_init__(self):
        _path(self.run_root, "run_root")
        _path(self.image, "image")
        if not self.image.endswith(".sqsh"):
            raise ValidationError("image must be a pre-staged immutable .sqsh file")
        _integer(self.time_minutes, 1, 525600, "time limit")
        if not self.users or not self.partitions or not self.qos:
            raise ValidationError("Explicit user, partition and QOS allowlists are required")
        for name in self.qos:
            _token(name, "QOS")
        if self.default_partition not in self.partitions or self.default_qos not in self.qos:
            raise ValidationError("Defaults must be allowlisted")
        for name, limits in self.partitions.items():
            _token(name, "partition")
            _token(limits.gpu_type, "GPU type")
            _integer(limits.max_cards, 1, 1024, "partition card limit")
            _integer(limits.cpus_per_gpu, 1, 256, "CPUs per GPU")
            _integer(limits.memory_mib_per_gpu, 1, 4194304, "memory per GPU")
            if type(limits.min_vram_gib) not in (int, float) or not math.isfinite(limits.min_vram_gib) or limits.min_vram_gib <= 0:
                raise ValidationError("Invalid verified GPU memory capacity")
        names = set()
        for user_id, access in self.users.items():
            if not isinstance(user_id, str) or not 1 <= len(user_id) <= 128 or any(ord(c) < 32 for c in user_id):
                raise ValidationError("Invalid platform user ID")
            if not LINUX_USER.fullmatch(access.linux_user) or access.linux_user in {"root", "nobody"} or access.linux_user in names:
                raise ValidationError("Linux identities must be distinct non-root users")
            names.add(access.linux_user)
            if not set(access.partitions) <= set(self.partitions) or not set(access.qos) <= set(self.qos):
                raise ValidationError("Invalid per-user partition/QOS allowlist")


@dataclass(frozen=True)
class Command:
    user: str
    argv: tuple[str, ...]
    stdin: str | None = None
    timeout: int = 5


def run_command(command: Command) -> str:
    """Run as the mapped user, never with inherited SBATCH_*/SLURM_* secrets."""
    account = pwd.getpwnam(command.user)
    if account.pw_uid == 0:
        raise ValidationError("Refusing to execute scheduler commands as root")
    options = {}
    if os.geteuid() == 0:
        options = {"user": account.pw_uid, "group": account.pw_gid, "extra_groups": os.getgrouplist(command.user, account.pw_gid)}
    elif os.geteuid() != account.pw_uid:
        raise ValidationError("Executor must run as the mapped user or a privileged identity-switching service")
    env = {"PATH": "/usr/bin:/bin", "HOME": account.pw_dir, "USER": command.user, "LOGNAME": command.user, "LANG": "C.UTF-8", "TZ": "UTC"}
    result = subprocess.run(command.argv, input=command.stdin, text=True, capture_output=True,
                            timeout=command.timeout, env=env, cwd="/", **options)
    if result.returncode:
        raise ReconciliationError((result.stderr or result.stdout or "Slurm command failed")[-400:])
    if len(result.stdout.encode()) > 2_000_000:
        raise ReconciliationError("Slurm response too large")
    return result.stdout


def normalize_state(raw: str, exit_code: str = "") -> str:
    """Never infer success from disappearance, truncation, or an unknown state."""
    value = raw.strip()
    if re.fullmatch(r"CANCELLED(?: by [0-9]+)?", value):
        return "CANCELED"
    if value == "COMPLETED":
        if not re.fullmatch(r"[0-9]+:[0-9]+", exit_code):
            return "UNKNOWN"
        return "SUCCEEDED" if exit_code == "0:0" else "FAILED"
    if value in {"BOOT_FAIL", "DEADLINE", "FAILED", "NODE_FAIL", "OUT_OF_MEMORY", "PREEMPTED", "REVOKED", "TIMEOUT"}:
        return "FAILED"
    if value in {"PENDING", "REQUEUED", "REQUEUE_FED", "REQUEUE_HOLD"}:
        return "PENDING"
    if value in {"CONFIGURING", "POWER_UP_NODE"}:
        return "STARTING"
    if value in {"RUNNING", "COMPLETING", "SUSPENDED", "STOPPED", "RESIZING", "SIGNALING", "STAGE_OUT"}:
        return "RUNNING"
    return "UNKNOWN"


def validate_job(job: dict, policy: Policy, *, authorize: bool = True) -> dict:
    if not isinstance(job, dict):
        raise ValidationError("Job must be an object")
    extra = set(job) - JOB_FIELDS
    if extra:
        raise ValidationError("Unsupported Slurm/GPUQ options: " + ", ".join(sorted(extra)))
    if not REQUIRED_FIELDS <= set(job):
        raise ValidationError("Incomplete job specification")
    if not isinstance(job["id"], str) or not UUID.fullmatch(job["id"]):
        raise ValidationError("Invalid platform job UUID")
    if not isinstance(job["userId"], str) or job["userId"] not in policy.users:
        raise ValidationError("User is not allowlisted")
    if not isinstance(job["username"], str) or not 1 <= len(job["username"]) <= 64 or any(ord(c) < 32 for c in job["username"]):
        raise ValidationError("Invalid display username")
    if not isinstance(job["name"], str) or not 1 <= len(job["name"]) <= 64 or any(ord(c) < 32 for c in job["name"]):
        raise ValidationError("Invalid display job name")
    argv = job["argv"]
    if not isinstance(argv, list) or not 1 <= len(argv) <= 128 or any(not isinstance(a, str) or "\0" in a for a in argv) or not argv[0] or argv[0].startswith("-") or len(json.dumps(argv)) > 12000:
        raise ValidationError("Invalid command argv")
    partition = job.get("partition", policy.default_partition)
    qos = job.get("qos", policy.default_qos)
    _token(partition, "partition")
    _token(qos, "QOS")
    access = policy.users[job["userId"]]
    _integer(job["cards"], 1, 1024, "GPU count")
    minimum = job["minVramGiB"]
    if type(minimum) not in (int, float) or not math.isfinite(minimum) or minimum < 0:
        raise ValidationError("Invalid minimum GPU memory")
    if authorize:
        if partition not in access.partitions or qos not in access.qos:
            raise ValidationError("Partition/QOS is not authorized for this user")
        limits = policy.partitions[partition]
        _integer(job["cards"], 1, limits.max_cards, "GPU count")
        if minimum > limits.min_vram_gib:
            raise ValidationError("Minimum GPU memory is not guaranteed by this partition")
    return {**job, "argv": list(argv), "partition": partition, "qos": qos}


def _identity(job):
    fingerprint = hashlib.sha256(json.dumps(job, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    return fingerprint, "gpuq-" + job["id"], "gpuq:" + job["id"] + ":" + fingerprint


def build_submit(job: dict, policy: Policy) -> Command:
    job = validate_job(job, policy)
    _, name, comment = _identity(job)
    user = policy.users[job["userId"]].linux_user
    limits = policy.partitions[job["partition"]]
    directory = policy.run_root + "/" + hashlib.sha256(job["userId"].encode()).hexdigest()[:32] + "/" + job["id"]
    # shlex.join quotes each argv value. No user value becomes an sbatch option,
    # shell expansion, #SBATCH directive, or host-side command outside srun.
    task = ("/usr/bin/srun", "--export=ALL", "--container-image=" + policy.image,
            "--no-container-mount-home", "--container-readonly", "--container-workdir=/workspace",
            "--container-mounts=" + directory + ":/workspace", "--", *job["argv"])
    script = "#!/bin/sh\nset -eu\nexec " + shlex.join(task) + "\n"
    return Command(user, ("/usr/bin/sbatch", "--parsable", "--job-name=" + name, "--comment=" + comment,
                          "--partition=" + job["partition"], "--qos=" + job["qos"], "--nodes=1", "--ntasks=1",
                          "--gres=gpu:" + limits.gpu_type + ":" + str(job["cards"]),
                          "--cpus-per-task=" + str(limits.cpus_per_gpu * job["cards"]),
                          "--mem=" + str(limits.memory_mib_per_gpu * job["cards"]) + "M",
                          "--time=" + str(policy.time_minutes), "--no-requeue", "--export=NIL",
                          "--chdir=" + directory, "--output=" + directory + "/slurm-%j.out",
                          "--error=" + directory + "/slurm-%j.err"), script, 6)


def build_status(user: str, name: str, created: str) -> tuple[Command, Command]:
    if not isinstance(user, str) or not LINUX_USER.fullmatch(user) or user == "root" or not re.fullmatch(r"gpuq-[a-f0-9-]{36}", name):
        raise ValidationError("Invalid status identity")
    start = (datetime.fromisoformat(created) - timedelta(minutes=5)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    return (Command(user, ("/usr/bin/squeue", "--local", "--noheader", "--states=all", "--user=" + user,
                           "--name=" + name, "--format=%i|%u|%j|%T|%k"), timeout=4),
            Command(user, ("/usr/bin/sacct", "--local", "--noheader", "--parsable2", "--allocations", "--user=" + user,
                           "--name=" + name, "--starttime=" + start, "--endtime=now",
                           "--format=JobIDRaw,User,JobName%128,State%64,ExitCode,Comment%256"), timeout=4))


def build_cancel(user: str, name: str, slurm_id: str) -> Command:
    if not isinstance(user, str) or not LINUX_USER.fullmatch(user) or user == "root" or not re.fullmatch(r"gpuq-[a-f0-9-]{36}", name):
        raise ValidationError("Invalid cancellation identity")
    if not isinstance(slurm_id, str) or not JOB_ID.fullmatch(slurm_id):
        raise ValidationError("Only an exact reconciled allocation ID may be canceled")
    return Command(user, ("/usr/bin/scancel", "--ctld", "--user=" + user, "--name=" + name, slurm_id))


def parse_records(text: str, accounting: bool) -> list[dict]:
    if not isinstance(text, str) or len(text.encode()) > 2_000_000:
        raise ReconciliationError("Invalid Slurm response")
    records = []
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) != (6 if accounting else 5):
            raise ReconciliationError("Malformed Slurm output; refusing to infer absence")
        jid, user, name, state = parts[:4]
        if not JOB_ID.fullmatch(jid):
            raise ReconciliationError("Unsupported array/step/federated Slurm record")
        records.append({"id": jid, "user": user, "name": name, "raw": state,
                        "exit": parts[4] if accounting else "", "comment": parts[-1]})
    return records


class SlurmBackend:
    def __init__(self, policy: Policy, ledger: str | Path, runner: Callable[[Command], str] = run_command):
        self.policy, self.runner = policy, runner
        self.ledger = Path(ledger)
        self._private_directory(self.ledger.parent)
        self.locks = self.ledger.parent / (self.ledger.name + ".locks")
        self._private_directory(self.locks)
        fd = os.open(self.ledger, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077:
                raise ValidationError("Ledger must be private, service-owned, and a single regular file")
        finally:
            os.close(fd)
        with self._db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS dispatch (
                id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, linux_user TEXT NOT NULL,
                name TEXT NOT NULL, comment TEXT NOT NULL, created TEXT NOT NULL,
                attempted INTEGER NOT NULL DEFAULT 0, slurm_id TEXT,
                canceled INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'UNKNOWN',
                raw_state TEXT NOT NULL DEFAULT '', exit_code TEXT NOT NULL DEFAULT '')""")

    @staticmethod
    def _private_directory(path):
        path.mkdir(parents=True, mode=0o700, exist_ok=True)
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValidationError("Ledger directory must be private and service-owned")

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.ledger, timeout=25)
        try:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA synchronous=FULL")
            with db:
                yield db
        finally:
            db.close()

    @contextmanager
    def _lock(self, jid):
        fd = os.open(self.locks / jid, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def _get(self, job, create=False):
        fingerprint, name, comment = _identity(job)
        user = self.policy.users[job["userId"]].linux_user
        with self._db() as db:
            row = db.execute("SELECT * FROM dispatch WHERE id=?", (job["id"],)).fetchone()
            if row is None and create:
                db.execute("INSERT INTO dispatch(id,fingerprint,linux_user,name,comment,created) VALUES(?,?,?,?,?,?)",
                           (job["id"], fingerprint, user, name, comment, datetime.now(timezone.utc).isoformat()))
                row = db.execute("SELECT * FROM dispatch WHERE id=?", (job["id"],)).fetchone()
        if row is not None and (row["fingerprint"] != fingerprint or row["linux_user"] != user):
            raise ValidationError("Job UUID is already bound to a different request or Linux identity")
        return dict(row) if row is not None else None

    def _save(self, row):
        with self._db() as db:
            db.execute("UPDATE dispatch SET attempted=?,slurm_id=?,canceled=?,state=?,raw_state=?,exit_code=? WHERE id=?",
                       (row["attempted"], row["slurm_id"], row["canceled"], row["state"], row["raw_state"], row["exit_code"], row["id"]))

    @staticmethod
    def _result(row, error=None):
        result = {"state": row["state"], "nodeJobId": row["slurm_id"], "slurmState": row["raw_state"],
                  "exitCode": row["exit_code"] or None, "cancelRequested": bool(row["canceled"]), "assignedIndices": []}
        if error:
            result["error"] = str(error)[:400]
        return result

    def _lookup(self, row):
        queue, account = build_status(row["linux_user"], row["name"], row["created"])
        # Both sources must be readable. A DB outage is not proof of no job.
        active = parse_records(self.runner(queue), False)
        history = parse_records(self.runner(account), True)
        matches = []
        for record in active + history:
            if record["name"] != row["name"]:
                raise ReconciliationError("Unexpected Slurm record outside exact job-name filter")
            if record["user"] != row["linux_user"] or record["comment"] != row["comment"]:
                raise ReconciliationError("Slurm owner/fingerprint mismatch (check accounting job_comment)")
            matches.append(record)
        ids = {r["id"] for r in matches}
        if len(ids) > 1 or (ids and row["slurm_id"] and row["slurm_id"] not in ids):
            raise ReconciliationError("Multiple or conflicting Slurm allocations for one platform UUID")
        if not matches:
            return None
        # Queue is live; accounting may lag a start/requeue. COMPLETED needs its
        # accounting exit code, otherwise success remains unconfirmed.
        chosen = active[0] if active else history[0]
        if chosen["raw"] == "COMPLETED" and history:
            chosen = history[0]
        row.update(slurm_id=chosen["id"], attempted=1, state=normalize_state(chosen["raw"], chosen["exit"]),
                   raw_state=chosen["raw"], exit_code=chosen["exit"])
        self._save(row)
        return chosen

    def submit(self, request):
        """Submit once; repeated calls only reconcile the same immutable job."""
        job = validate_job(request, self.policy, authorize=False)
        with self._lock(job["id"]):
            row = self._get(job)
            if row is None:
                validate_job(job, self.policy)
                row = self._get(job, create=True)
            if row["state"] in TERMINAL:
                return self._result(row)
            try:
                if self._lookup(row):
                    return self._result(row)
            except (OSError, subprocess.SubprocessError, ReconciliationError) as error:
                return self._result({**row, "state": "UNKNOWN"}, error)
            if row["canceled"] and not row["attempted"]:
                row["state"] = "CANCELED"
                self._save(row)
                return self._result(row)
            if row["attempted"]:
                return self._result({**row, "state": "UNKNOWN"}, "Submission outcome not visible; not resubmitting")
            validate_job(job, self.policy)
            # Durable intent before sbatch: a crash here is deliberately fail-closed.
            row["attempted"] = 1
            self._save(row)
            try:
                output = self.runner(build_submit(job, self.policy)).strip()
                if not JOB_ID.fullmatch(output):
                    raise ReconciliationError("Unrecognized sbatch receipt; reconciling by UUID is required")
                row["slurm_id"] = output
                self._save(row)
                if self._lookup(row):
                    return self._result(row)
            except (OSError, subprocess.SubprocessError, ReconciliationError) as error:
                return self._result({**row, "state": "UNKNOWN"}, error)
            return self._result({**row, "state": "UNKNOWN"}, "Accepted receipt, awaiting authoritative Slurm state")

    def status(self, request):
        job = validate_job(request, self.policy, authorize=False)
        with self._lock(job["id"]):
            row = self._get(job)
            if row is None:
                return {"state": "UNKNOWN", "nodeJobId": None, "assignedIndices": [], "error": "Job is not recorded in the dispatch ledger"}
            if row["state"] in TERMINAL:
                return self._result(row)
            try:
                if self._lookup(row):
                    return self._result(row)
                return self._result({**row, "state": "UNKNOWN"}, "Job is absent from queue and accounting; reservation retained")
            except (OSError, subprocess.SubprocessError, ReconciliationError) as error:
                return self._result({**row, "state": "UNKNOWN"}, error)

    def cancel(self, request):
        job = validate_job(request, self.policy, authorize=False)
        with self._lock(job["id"]):
            row = self._get(job, create=True)
            if row["state"] in TERMINAL:
                return self._result(row)
            row["canceled"] = 1
            self._save(row)
            try:
                match = self._lookup(row)
                if not match:
                    if not row["attempted"]:
                        row["state"] = "CANCELED"
                        self._save(row)
                        return self._result(row)
                    return self._result({**row, "state": "UNKNOWN"}, "Cannot confirm which allocation to cancel")
                if row["state"] in TERMINAL:
                    return self._result(row)
                self.runner(build_cancel(row["linux_user"], row["name"], row["slurm_id"]))
                if self._lookup(row):
                    return self._result(row)
                return self._result({**row, "state": "UNKNOWN"}, "Cancellation requested, awaiting Slurm confirmation")
            except (OSError, subprocess.SubprocessError, ReconciliationError) as error:
                return self._result({**row, "state": "UNKNOWN"}, error)
