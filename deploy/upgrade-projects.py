#!/usr/bin/env python3
"""Add project v2 beside legacy workspaces, without restarting anything.

The existing config is read, backed up byte-for-byte and NEVER rewritten.
Compile a pinned in-memory copy of every source before making any change;
install dependencies first and the request dispatcher last. Existing GPUQ
databases, jobs, terminal helpers and user data are not opened for modification.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import stat
import tempfile
import time


FILES = ('project-store.py', 'project-ops.py', 'sandbox-runner.py', 'node-executor.py')
MAX_FILE_BYTES = 8 * 1024 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def checked_path(path):
    path = Path(path)
    if (not path.is_absolute() or path == Path('/') or '..' in path.parts or
            any(ord(character) < 32 for character in str(path))):
        raise SystemExit('An absolute non-root path without traversal is required')
    return path


@contextlib.contextmanager
def opened_directory(path):
    """Reject symbolic links in every component, not just the last one."""
    path = checked_path(path)
    descriptor = os.open('/', DIR_FLAGS)
    try:
        for part in path.parts[1:]:
            child = os.open(part, DIR_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


def checked_directory(path, private=False, allow_root=False):
    with opened_directory(path) as descriptor:
        info = os.fstat(descriptor)
        owners = {os.getuid(), 0} if allow_root else {os.getuid()}
        if info.st_uid not in owners or info.st_mode & (0o077 if private else 0o022):
            raise SystemExit('Unsafe directory owner or permissions: ' + path.name)
        return info.st_dev, info.st_ino


def stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def checked_file(path, private=True, allow_root=False):
    with opened_directory(path.parent) as parent:
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(descriptor)
            owners = {os.getuid(), 0} if allow_root else {os.getuid()}
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid not in owners or
                    info.st_mode & (0o077 if private else 0o022) or info.st_mode & 0o6000 or
                    info.st_size > MAX_FILE_BYTES):
                raise SystemExit('Unsafe or oversized node file: ' + path.name)
            chunks, remaining = [], MAX_FILE_BYTES + 1
            while remaining:
                chunk = os.read(descriptor, min(remaining, 1024 * 1024))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            current = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
            if not remaining or stamp(info) != stamp(os.fstat(descriptor)) or stamp(info) != stamp(current):
                raise SystemExit('Node file changed while being read: ' + path.name)
            return b''.join(chunks), stamp(info)
        finally:
            os.close(descriptor)


def safe_file(path, private=True):
    """Compatibility helper for local callers; no chmod or ownership repair."""
    checked_file(path, private=private)


def atomic_copy(source, destination, mode=0o700):
    """Install the exact precompiled bytes, never re-open a mutable source."""
    payload = source if isinstance(source, bytes) else checked_file(source, private=False, allow_root=True)[0]
    descriptor, name = tempfile.mkstemp(prefix='.project-upgrade-', dir=destination.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(payload)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        os.replace(name, destination)
        with opened_directory(destination.parent) as parent:
            os.fsync(parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--source', default=Path(__file__).resolve().parent, type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    if os.getuid() == 0 or os.geteuid() != os.getuid():
        raise SystemExit('Run as the existing execution service user, not root')
    directory, source_directory = checked_path(args.directory), checked_path(args.source)
    directory_identity = checked_directory(directory, private=True)
    checked_directory(source_directory, allow_root=True)
    config_file = directory / 'node-config.json'
    config_bytes, config_stamp = checked_file(config_file)
    config = json.loads(config_bytes)
    if not isinstance(config, dict) or not all(key in config for key in ('root', 'conda', 'gpu', 'database')):
        raise SystemExit('Upgrade the execution/dataset base before project support')
    for key in ('root', 'conda'):
        if not isinstance(config[key], str):
            raise SystemExit('Existing project storage/base must be an absolute directory')
        path = checked_path(Path(config[key]))
        checked_directory(path, allow_root=key == 'conda')
    payloads, previous = {}, {'node-config.json': config_bytes}
    for name in FILES:
        payload, _ = checked_file(source_directory / name, private=False, allow_root=True)
        compile(payload, str(source_directory / name), 'exec')
        payloads[name] = payload
        destination = directory / name
        # lexists catches dangling symlinks too: they must not be overwritten.
        if os.path.lexists(destination):
            previous[name] = checked_file(destination, private=False)[0]
    summary = {'files': list(FILES), 'configurationUnchanged': True,
               'schedulerUnchanged': True, 'restartRequired': False}
    if not args.apply:
        print(json.dumps({'dryRun': True, **summary}))
        return

    # Recheck the config and directory before the first write. Never overwrite
    # an operator's concurrent config update, nor pretend it was our change.
    if checked_directory(directory, private=True) != directory_identity or checked_file(config_file) != (config_bytes, config_stamp):
        raise SystemExit('Node configuration/directory changed during preflight; nothing installed')
    backup = directory / ('before-projects-' + str(time.time_ns()))
    backup.mkdir(mode=0o700)
    for name, content in previous.items():
        atomic_copy(content, backup / name, mode=0o600 if name == 'node-config.json' else 0o700)
    with opened_directory(directory) as descriptor:
        os.fsync(descriptor)
    # Dependencies first, dispatcher last. Old running processes and old specs
    # remain valid; no users/, jobs/, terminal pointers or GPUQ DB are modified.
    try:
        if checked_file(config_file) != (config_bytes, config_stamp):
            raise SystemExit('Node configuration changed while backing up; nothing installed')
        for name in FILES:
            atomic_copy(payloads[name], directory / name)
    except OSError as error:
        raise SystemExit('Project upgrade did not finish; private backup retained at ' + str(backup) + '; no service was restarted') from error
    if checked_file(config_file) != (config_bytes, config_stamp):
        raise SystemExit('Config changed externally during installation; no config was overwritten; review retained backup at ' + str(backup))
    print(json.dumps({'upgraded': True, 'backup': str(backup), **summary}))


if __name__ == '__main__':
    main()
