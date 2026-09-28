"""Explicit, additive LAN synchronization; never mirrors deletions/overwrites.

Rsync owns the binary transfer/resume protocol. GPUQ owns path validation,
conflict previews and a durable 'not ready' fence for managed training starts.
"""
from __future__ import annotations

import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from typing import Any, Iterator

from .config import Config
from .fleet import host_paths, load_inventory, packet, ssh_command
from .protocol import Client, ProtocolError
from .util import atomic_write_json

PARTIAL = ".gpuq-sync-partial"
IGNORED = {PARTIAL, ".git", ".venv", "__pycache__", ".env", ".ssh"}
BROAD = {"/", "/home", "/Users", "/root", "/data1", "/data2", "/tmp", "/var/tmp"}
PROTECTED = ("/etc", "/usr", "/bin", "/sbin", "/proc", "/sys", "/dev", "/run", "/var/lib")


def related(first: Path, second: Path) -> bool:
    return first == second or first in second.parents or second in first.parents


def valid_path(value: str, protected_root: Path | None = None) -> Path:
    if not isinstance(value, str) or not value.startswith("/") or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("sync path must be absolute without control characters")
    path = Path(os.path.normpath(value))
    whole_home = path == Path.home() or path.parent in (Path("/home"), Path("/Users"))
    if ".." in Path(value).parts or str(path) in BROAD or whole_home:
        raise ValueError("refusing broad/parent-traversal sync path")
    if any(p in path.parts for p in (".ssh", "anaconda3", "miniconda3", ".conda")):
        raise ValueError("credential and environment directories are not sync targets")
    if protected_root is not None and related(path, protected_root):
        raise ValueError("cannot sync scheduler state or release directories")
    if any(path == Path(p) or Path(p) in path.parents for p in PROTECTED):
        raise ValueError("cannot sync system directories")
    for component in (path, *path.parents):
        if component.is_symlink():
            raise ValueError("symlink path component is not supported: " + str(component))
    if path.exists() and not path.is_dir():
        raise ValueError("sync destination/source must be a directory")
    return path


def exclusions(values: list[str]) -> list[str]:
    result = []
    for value in values:
        if not isinstance(value, str) or not value or value.startswith("/") or ".." in Path(value).parts or any(c in value for c in "*?[]\n\r\0"):
            raise ValueError("--exclude takes an exact relative path, not a glob")
        result.append(value.rstrip("/"))
    return sorted(set(result))


def scan(path: Path, excluded: list[str]) -> dict[str, Any]:
    digest = hashlib.sha256()
    count = total = 0
    if not path.exists():
        return {"files": 0, "bytes": 0, "stamp": digest.hexdigest()}
    for directory, dirs, files in os.walk(path, followlinks=False):
        parent = Path(directory)
        def skipped(name: str) -> bool:
            relative = (parent / name).relative_to(path).as_posix()
            return name in IGNORED or any(relative == e or relative.startswith(e + "/") for e in excluded)
        dirs[:] = sorted(name for name in dirs if not skipped(name))
        for name in sorted([*dirs, *(n for n in files if not skipped(n))]):
            entry = parent / name
            info = entry.lstat()
            if any(ord(c) < 32 or ord(c) == 127 for c in name):
                raise ValueError("control characters in filenames are not supported")
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise ValueError("symlink/special file requires explicit exclusion: " + str(entry))
            if stat.S_ISREG(info.st_mode):
                count += 1
                total += info.st_size
                digest.update(json.dumps([entry.relative_to(path).as_posix(), info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino], ensure_ascii=False).encode())
    return {"files": count, "bytes": total, "stamp": digest.hexdigest()}


def guard_path(root: Path, dest: str) -> Path:
    return root / "sync" / "guards" / (hashlib.sha256(dest.encode()).hexdigest() + ".json")


def job_paths(job: dict[str, Any]) -> list[Path]:
    paths = [Path(job["cwd"])]
    for argument in job.get("argv", []):
        # Absolute declared arguments (including --data=/path) are visible to
        # GPUQ. Arbitrary paths hidden inside user code cannot be discovered.
        value = argument.split("=", 1)[-1]
        if value.startswith("/"):
            paths.append(Path(value).resolve())
    raw_inputs = job.get("env", {}).get("GPU_SYNC_INPUT_PATHS")
    if raw_inputs:
        try:
            declared = json.loads(raw_inputs)
            if isinstance(declared, list):
                paths.extend(Path(value).resolve() for value in declared if isinstance(value, str) and value.startswith("/"))
        except (ValueError, TypeError):
            pass
    return paths


def job_blocked(root: Path, job: dict[str, Any]) -> bool:
    directory = root / "sync" / "guards"
    if not directory.is_dir():
        return False
    paths = job_paths(job)
    for filename in directory.glob("*.json"):
        try:
            data = json.loads(filename.read_text())
            dest = Path(data["dest"])
        except (OSError, ValueError, KeyError):
            # A damaged fence must not permit new starts against unknown data.
            return True
        if any(related(path, dest) for path in paths):
            return True
    return False


@contextlib.contextmanager
def destination_lock(root: Path, dest: str) -> Iterator[int]:
    path = guard_path(root, dest).with_suffix(".lock")
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError("another transfer is using this destination") from exc
        yield descriptor
    finally:
        os.close(descriptor)


def node_api(coordinator: Any, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
    dest = valid_path(payload["dest"], coordinator.config.root)
    token = str(uuid.UUID(payload["token"]))
    filename = guard_path(coordinator.config.root, str(dest))
    if operation == "sync_begin":
        from .constants import ACTIVE_ATTEMPT_STATES
        for attempt in coordinator.store.list_attempts(states=ACTIVE_ATTEMPT_STATES, limit=10000):
            job = coordinator.store.get_job(attempt["job_id"])
            if any(related(path, dest) for path in job_paths(job)):
                raise ValueError("destination overlaps active/planned GPUQ job " + job["id"])
        if filename.exists():
            previous = json.loads(filename.read_text())
            if previous["token"] != token:
                raise ValueError("unfinished sync belongs to another source; resume its original command")
        filename.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        atomic_write_json(filename, {"dest": str(dest), "token": token, "source": payload.get("source"), "since": time.time()})
        return {"ready": False, "dest": str(dest)}
    if operation == "sync_finish":
        with destination_lock(coordinator.config.root, str(dest)):
            if filename.exists():
                old = json.loads(filename.read_text())
                if old["token"] != token:
                    raise ValueError("sync completion token mismatch")
                filename.unlink()
        return {"ready": True, "dest": str(dest)}
    raise ValueError("unknown sync operation")


def control_entry(args: Any) -> int:
    config = Config.from_json(args.config)
    if args.operation not in {"finish", "git_publish", "git_plan"}:
        raise ValueError("unsupported sync control")
    payload = json.loads(args.payload)
    if args.operation == "git_plan":
        result = git_plan(config, payload)
    elif args.operation == "git_publish":
        result = git_publish(config, payload)
    else:
        result = Client(config.socket_path).call("sync_finish", payload)
    print(json.dumps(result, ensure_ascii=False))
    return 0


def decode_header(encoded: str) -> dict[str, Any]:
    if len(encoded) > 16000:
        raise ValueError("sync header too large")
    meta = json.loads(base64.urlsafe_b64decode(encoded.encode()))
    if set(meta) != {"dest", "token", "source", "phase", "required_bytes", "exclude"}:
        raise ValueError("invalid sync header")
    uuid.UUID(meta["token"])
    if meta["phase"] not in {"plan", "copy"} or type(meta["required_bytes"]) is not int or meta["required_bytes"] < 0:
        raise ValueError("invalid sync phase/size")
    meta["exclude"] = exclusions(meta["exclude"])
    return meta


def receiver(encoded: str, server_args: list[str], config_path: str) -> int:
    meta = decode_header(encoded)
    config = Config.from_json(config_path)
    dest = valid_path(meta["dest"], config.root)
    # These are rsync 3.2.x receiver arguments, never a sender, arbitrary
    # command or deletion-enabled receiver. Destination comes from the header.
    plan = meta["phase"] == "plan"
    expected = ["--server", "-nOrce.iLsfxCIvu", "--log-format=%i", ".", str(dest) + "/"] if plan else ["--server", "-Otre.iLsfxCIvu", "--partial-dir", PARTIAL, "--ignore-existing", ".", str(dest) + "/"]
    if server_args != expected:
        raise ValueError("unsupported rsync receiver options/version; refusing unsafe fallback")
    if not dest.parent.is_dir():
        raise ValueError("destination parent directory must already exist")
    scan(dest, meta["exclude"])
    if plan:
        return subprocess.run(["rsync", *expected], check=False).returncode
    with destination_lock(config.root, str(dest)) as descriptor:
        free = shutil.disk_usage(dest.parent).free
        if free < meta["required_bytes"] + 256 * 1024 * 1024:
            raise ValueError("insufficient disk space (including 256 MiB safety reserve)")
        Client(config.socket_path).call("sync_begin", {**meta, "dest": str(dest)})
        process = subprocess.Popen(["rsync", *expected], pass_fds=(descriptor,))
        try:
            return process.wait()
        except BaseException:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise


def forced_receiver(config_path: str) -> int | None:
    original = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    words = shlex.split(original)
    if len(words) >= 3 and words[1] == "_sync-rsync":
        return receiver(words[2], words[3:], config_path)
    if len(words) >= 5 and words[1] == "--config" and words[3] == "_sync-rsync":
        # The client's requested path cannot replace the SSH forced-command
        # configuration. Match it, then pass only our trusted server-side value.
        if words[2] != str(config_path):
            raise ValueError("sync config does not match the forced server configuration")
        return receiver(words[4], words[5:], config_path)
    if "_sync-rsync" in words:
        raise ValueError("unsupported sync receiver command layout")
    return None


def rsync_command(source: Path, dest: str, host: dict[str, Any], meta: dict[str, Any]) -> list[str]:
    encoded = base64.urlsafe_b64encode(json.dumps(meta, separators=(",", ":")).encode()).decode()
    binary, config = host_paths(host)
    remote = shlex.join([binary, "--config", config, "_sync-rsync", encoded])
    base = ["rsync", "-rcn", "--omit-dir-times", "--itemize-changes", "--out-format=%i|%l|%n"] if meta["phase"] == "plan" else ["rsync", "-rt", "--omit-dir-times", "--ignore-existing", "--partial-dir=" + PARTIAL, "--info=progress2"]
    for value in sorted(IGNORED):
        base += ["--exclude=" + value]
    for value in meta["exclude"]:
        base += ["--exclude=/" + value]
    return [*base, "--rsync-path=" + remote, "-e", shlex.join(ssh_command(host)[:-2]), "--", str(source) + "/", host["ssh"] + ":" + dest + "/"]


def preview(command: list[str]) -> dict[str, Any]:
    count = size = conflicts = 0
    examples: list[str] = []
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, text=True)
        try:
            assert process.stdout is not None
            for line in process.stdout:
                fields = line.rstrip("\n").split("|", 2)
                if len(fields) != 3 or len(fields[0]) != 11:
                    continue
                changes, length, name = fields
                if changes[1] == "f":
                    if changes[2:] != "+" * 9:
                        conflicts += 1
                    else:
                        count += 1
                        size += int(length)
                if len(examples) < 50:
                    examples.append(changes + " " + name)
            code = process.wait()
            if code:
                errors.seek(0)
                raise ValueError("rsync preview failed: " + errors.read(8192).decode(errors="replace"))
        except BaseException:
            process.terminate()
            process.wait()
            raise
    return {"new_files": count, "new_bytes": size, "conflicts": conflicts, "examples": examples}


def remote_control(host: dict[str, Any], operation: str, payload: dict[str, Any]) -> Any:
    result = subprocess.run(ssh_command(host), input=packet(["_sync", operation, json.dumps(payload)]), capture_output=True, timeout=120)
    if result.returncode:
        raise ValueError(result.stderr.decode(errors="replace"))
    return json.loads(result.stdout)


def transfer(source: Path, dest: str, host: dict[str, Any], excluded: list[str], *, dry_run: bool, as_json: bool, identity: str | None = None) -> dict[str, Any]:
    before = scan(source, excluded)
    source_id = identity or (socket.gethostname() + ":" + str(source))
    token = str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps([source_id, dest, excluded])))
    meta = {"dest": dest, "source": source_id, "token": token, "phase": "plan", "required_bytes": 0, "exclude": excluded}
    print("正在比较目录与文件内容…", file=sys.stderr, flush=True)
    plan = preview(rsync_command(source, dest, host, meta))
    plan.update(source=str(source), destination=dest, dry_run=dry_run)
    if not as_json:
        for item in plan["examples"]:
            print(item)
        print(f"新增 {plan['new_files']} 个文件 / {plan['new_bytes']} 字节；冲突 {plan['conflicts']} 个")
    if dry_run:
        return plan
    if plan["conflicts"]:
        raise ValueError("同名文件内容冲突：未复制或覆盖任何文件。请换目标目录或手动解决后重试。")
    if scan(source, excluded) != before:
        raise ValueError("source changed during preview; retry when its files are stable")
    if plan["new_files"] or any(item.startswith("cd") for item in plan["examples"]):
        copying = {**meta, "phase": "copy", "required_bytes": plan["new_bytes"]}
        code = subprocess.run(rsync_command(source, dest, host, copying), stdout=sys.stderr if as_json else None, check=False).returncode
        if code:
            raise ValueError(f"rsync interrupted/failed ({code}); destination stays NOT READY. Rerun the same command to resume.")
    verified = preview(rsync_command(source, dest, host, meta))
    if verified["new_files"] or verified["conflicts"] or scan(source, excluded) != before:
        raise ValueError("verification/source stability failed; destination remains NOT READY")
    remote_control(host, "finish", {"dest": dest, "token": token})
    return {**plan, "verified": True, "ready": True}


def git_info(source: Path, ref: str) -> dict[str, str]:
    if not ref or ref.startswith("-") or any(ord(c) < 32 for c in ref):
        raise ValueError("invalid Git ref")
    def git(*args: str) -> str:
        return subprocess.check_output(["git", "-C", str(source), *args], text=True, stderr=subprocess.PIPE).strip()
    if Path(git("rev-parse", "--show-toplevel")) != source:
        raise ValueError("Git sync source must be the repository root")
    if git("status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("Git 工作区有未提交修改/未跟踪文件；请先提交，或显式使用 --mode files。不会悄悄漏传改动。")
    commit = git("rev-parse", "--verify", ref + "^{commit}")
    listing = git("ls-tree", "-r", commit)
    if any(line.startswith("160000 ") for line in listing.splitlines()):
        raise ValueError("submodules need explicit preparation; first version does not synchronize them")
    attributes = subprocess.run(["git", "-C", str(source), "grep", "-I", "-l", "version https://git-lfs.github.com/spec/v1", commit, "--"], capture_output=True, text=True)
    if attributes.returncode == 0:
        raise ValueError("Git LFS pointers detected; transfer their actual data separately")
    if attributes.returncode not in (0, 1):
        raise ValueError("could not inspect Git LFS pointers")
    return {"commit": commit, "ref_object": git("rev-parse", "--verify", ref), "source": str(source)}


def git_plan(config: Config, payload: dict[str, Any]) -> dict[str, Any]:
    dest = valid_path(payload["dest"], config.root)
    if not dest.parent.is_dir():
        raise ValueError("destination parent directory must already exist")
    commit = payload["commit"]
    if dest.exists():
        receipt = dest / ".git" / "gpuq-sync.json"
        if receipt.is_file() and json.loads(receipt.read_text()).get("commit") == commit:
            actual = subprocess.check_output(["git", "-C", str(dest), "rev-parse", "HEAD"], text=True).strip()
            dirty = subprocess.check_output(["git", "-C", str(dest), "status", "--porcelain", "--untracked-files=normal"], text=True).strip().splitlines()
            if actual == commit and not dirty:
                return {"commit": commit, "destination": str(dest), "unchanged": True}
        raise ValueError("Git target exists or was modified; choose a new target. No checkout/pull/reset will overwrite it.")
    return {"commit": commit, "destination": str(dest), "unchanged": False, "free_bytes": shutil.disk_usage(dest.parent).free}


def git_publish(config: Config, payload: dict[str, Any]) -> dict[str, Any]:
    dest = valid_path(payload["dest"], config.root)
    staging = valid_path(payload["staging"], config.root)
    commit = payload["commit"]
    if not isinstance(commit, str) or len(commit) not in (40, 64) or any(c not in "0123456789abcdef" for c in commit):
        raise ValueError("invalid Git commit")
    if staging.parent != dest.parent or staging.name != ".gpuq-git-" + hashlib.sha256((str(dest) + commit).encode()).hexdigest()[:24]:
        raise ValueError("invalid Git staging location")
    token = str(uuid.uuid5(uuid.NAMESPACE_URL, "git:" + str(dest) + ":" + commit))
    if git_plan(config, payload)["unchanged"]:
        Client(config.socket_path).call("sync_finish", {"dest": str(dest), "token": token})
        return {"ready": True, "commit": commit, "destination": str(dest), "unchanged": True}
    with destination_lock(config.root, str(dest)):
        Client(config.socket_path).call("sync_begin", {"dest": str(dest), "token": token, "source": "git:" + commit})
        build = staging / "checkout"
        receipt_path = staging / "checkout-owner.json"
        receipt = {"dest": str(dest), "commit": commit, "token": token}
        if receipt_path.exists():
            if json.loads(receipt_path.read_text()) != receipt:
                raise ValueError("Git staging ownership does not match this operation")
        else:
            if build.exists():
                raise ValueError("unrecognized existing checkout directory")
            atomic_write_json(receipt_path, receipt)
        if not build.exists():
            if shutil.disk_usage(staging).free < (staging / "source.bundle").stat().st_size + 256 * 1024 * 1024:
                raise ValueError("insufficient space for the local Git object database")
            subprocess.run(["git", "clone", "--no-checkout", str(staging / "source.bundle"), str(build)], check=True, stdout=sys.stderr, stderr=sys.stderr)
        subprocess.run(["git", "-C", str(build), "cat-file", "-e", commit + "^{commit}"], check=True)
        listing = subprocess.check_output(["git", "-C", str(build), "ls-tree", "-rlz", commit])
        required = sum(int(item.split(b"\t", 1)[0].split()[3]) for item in listing.split(b"\0") if item and item.split(b"\t", 1)[0].split()[3] != b"-")
        if shutil.disk_usage(staging).free < required + 256 * 1024 * 1024:
            raise ValueError("insufficient space for Git checkout; free space and rerun to continue")
        # Only the private, ownership-checked staging checkout may be replaced
        # while recovering a partial checkout. Never run this in destination.
        subprocess.run(["git", "-C", str(build), "checkout", "--detach", "--force", commit], check=True, stdout=sys.stderr, stderr=sys.stderr)
        subprocess.run(["git", "-C", str(build), "remote", "remove", "origin"], check=False, stdout=sys.stderr, stderr=sys.stderr)
        atomic_write_json(build / ".git" / "gpuq-sync.json", {"commit": commit})
        # Publish a fully checked-out tree without replacing any existing path.
        rename_new_directory(build, dest)
    Client(config.socket_path).call("sync_finish", {"dest": str(dest), "token": token})
    bundle = staging / "source.bundle"
    if bundle.is_file() and not bundle.is_symlink():
        bundle.unlink()  # Only our temporary transport bundle, after publication.
    receipt_path = staging / "checkout-owner.json"
    if receipt_path.is_file() and not receipt_path.is_symlink():
        receipt_path.unlink()
    try:
        staging.rmdir()
    except OSError:
        pass  # Never remove unexpected contents recursively.
    return {"ready": True, "commit": commit, "destination": str(dest)}


def rename_new_directory(source: Path, destination: Path) -> None:
    import ctypes
    library = ctypes.CDLL(None, use_errno=True)
    if not hasattr(library, "renameat2"):
        raise ValueError("atomic no-replace directory publication requires Linux renameat2")
    result = library.renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1)
    if result:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(destination))


def cmd_sync(args: Any) -> int:
    if args.host:
        raise ValueError("use sync --to HOST, not the global --host option")
    inventory = load_inventory(args.fleet_config)
    if args.to not in inventory["hosts"] or args.to == inventory.get("local_host"):
        raise ValueError("--to must name a different configured fleet host")
    source = valid_path(str(Path(args.source).absolute()))
    if not source.is_dir():
        raise ValueError("source directory does not exist")
    dest = str(valid_path(args.dest))
    excluded = exclusions(args.exclude)
    host = {"ssh": args.to, **inventory["hosts"][args.to]}
    mode = args.mode
    if mode == "auto":
        mode = "git" if (source / ".git").exists() else "files"
    try:
        if mode == "files":
            result = transfer(source, dest, host, excluded, dry_run=args.dry_run, as_json=args.json)
        else:
            if excluded:
                raise ValueError("Git sync transfers the chosen commit; --exclude is only for --mode files")
            info = git_info(source, args.ref)
            commit = info["commit"]
            destination_plan = remote_control(host, "git_plan", {"dest": dest, "commit": commit})
            staging = str(Path(dest).parent / (".gpuq-git-" + hashlib.sha256((dest + commit).encode()).hexdigest()[:24]))
            if args.dry_run:
                result = {**destination_plan, "mode": "git", "dry_run": True, "note": "Git checkout will use a new independent target directory"}
            elif destination_plan["unchanged"]:
                result = remote_control(host, "git_publish", {"dest": dest, "staging": staging, "commit": commit})
                result["mode"] = "git"
            else:
                with tempfile.TemporaryDirectory(prefix="gpuq-git-") as temporary:
                    directory = Path(temporary)
                    # A bundle is portable over our resumable file transport;
                    # no GitHub, branch push or source-index modification.
                    subprocess.run(["git", "-C", str(source), "bundle", "create", str(directory / "source.bundle"), args.ref], check=True)
                    heads = subprocess.check_output(["git", "bundle", "list-heads", str(directory / "source.bundle")], text=True)
                    if info["ref_object"] not in [line.split()[0] for line in heads.splitlines()]:
                        raise ValueError("Git ref changed while packaging; retry with a stable branch/tag")
                    transfer(directory, staging, host, [], dry_run=False, as_json=args.json, identity="git:" + socket.gethostname() + ":" + str(source) + ":" + commit)
                    result = remote_control(host, "git_publish", {"dest": dest, "staging": staging, "commit": commit})
                result["mode"] = "git"
    except KeyboardInterrupt:
        print("同步已中断；未覆盖或删除原文件。重跑相同命令可继续。", file=sys.stderr)
        return 130
    except subprocess.SubprocessError as exc:
        raise ValueError("sync subprocess failed: " + str(exc)) from exc
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 2 if result.get("conflicts") else 0
