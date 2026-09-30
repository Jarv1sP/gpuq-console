#!/usr/bin/env python3
"""Add dataset support to an existing node; preserve identity, scheduler and jobs."""
import argparse
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import time

DATASET_ROOT = Path('/data2/datasets')
# Legacy v1 executor/broker granted the authenticated hostAdmin route through
# this fixed root-owned sudo helper before hostRoot became an explicit setting.
# Exact source fingerprints avoid interpreting arbitrary customized Python as
# evidence of authorization. New installs already supply an explicit boolean.
LEGACY_EXECUTOR_SHA256 = '66b502f8f6f18a9bd6d528afb3edfdf135f9a450bbeb556afef98c949fd96c6b'
LEGACY_BROKER_SHA256 = '8b4d7b48c619074d2e7f989004aecffe47d81bd5909cae750021ea37599ee0c1'
LEGACY_ROOT_SHELL = Path('/usr/local/libexec/amax-console-root-shell')

def trusted_program_hash(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise SystemExit('Existing node helper must be a private service-owned regular file')
    return hashlib.sha256(path.read_bytes()).hexdigest()

def preserved_host_root(config, directory):
    if 'hostRoot' in config:
        if type(config['hostRoot']) is not bool:
            raise SystemExit('Existing hostRoot must be an explicit boolean')
        return config['hostRoot'], 'existing-config'
    if (trusted_program_hash(directory / 'node-executor.py') != LEGACY_EXECUTOR_SHA256
            or trusted_program_hash(directory / 'terminal-helper.py') != LEGACY_BROKER_SHA256):
        raise SystemExit('Legacy host-root behavior is unknown; review and set hostRoot explicitly before upgrading')
    try:
        info = LEGACY_ROOT_SHELL.lstat()
    except FileNotFoundError:
        raise SystemExit('Legacy root terminal helper is missing; cannot preserve existing administrator behavior')
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0
            or info.st_mode & 0o022 or not os.access(LEGACY_ROOT_SHELL, os.X_OK)):
        raise SystemExit('Unsafe legacy root terminal helper; no permission changes performed')
    return True, 'legacy-verified-root-wrapper'

def conda_path(config, old_runner):
    """Preserve an explicit environment or recover the old literal mount safely.

    Old nodes did not have a conda setting: their trusted runner mounted one
    absolute host path at /opt/conda. Parse that source without importing or
    executing the old runner. Never pick a different installed environment just
    because it exists, and never silently fall back from a broken explicit one.
    """
    if 'conda' in config:
        value, origin = config['conda'], 'existing-config'
    else:
        if old_runner.is_symlink() or not old_runner.is_file():
            raise SystemExit('Missing trusted legacy sandbox runner; configure conda explicitly')
        tree = ast.parse(old_runner.read_text(), filename=str(old_runner))
        candidates = set()
        for node in ast.walk(tree):
            if not isinstance(node, (ast.List, ast.Tuple)):
                continue
            items = node.elts
            for index in range(len(items) - 2):
                triple = items[index:index + 3]
                if (all(isinstance(item, ast.Constant) and isinstance(item.value, str) for item in triple)
                        and triple[0].value == '--ro-bind' and triple[2].value == '/opt/conda'):
                    candidates.add(triple[1].value)
        if len(candidates) != 1:
            raise SystemExit('Cannot identify one original Conda mount; configure conda explicitly before upgrade')
        value, origin = candidates.pop(), 'legacy-sandbox-mount'
    if (not isinstance(value, str) or not Path(value).is_absolute() or '..' in Path(value).parts
            or any(ord(char) < 32 for char in value) or value in ('/', '/home', '/usr', '/opt')):
        raise SystemExit('Conda must name an explicit absolute environment directory')
    path = Path(value)
    if not path.is_dir() or not (path / 'bin/python').is_file():
        raise SystemExit('Original Conda environment is unavailable; no fallback environment will be selected')
    return value, origin

def upgraded_config(config, old_runner, cache_root):
    if not isinstance(config, dict) or not all(k in config for k in ('root', 'gpu', 'database')):
        raise SystemExit('Not a configured execution node')
    value, origin = conda_path(config, old_runner)
    # Shallow-copy only: every existing field (including unknown future fields,
    # private workspace, scheduler DB and custom slirp binary) stays unchanged.
    result = dict(config)
    result['conda'] = value
    if 'datasets' in result and (not isinstance(result['datasets'], dict) or result['datasets'].get('root') != str(cache_root)):
        raise SystemExit('Existing dataset configuration must be reviewed manually')
    result.setdefault('datasets', {'root': str(cache_root), 'mountPoint': '/data2', 'sources': {}, 'reserveBytes': 20*1024**3})
    return result, origin

def atomic_copy(source, target):
    fd, temporary = tempfile.mkstemp(prefix='.dataset-upgrade-', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as out, source.open('rb') as inp:
            shutil.copyfileobj(inp, out); out.flush(); os.fsync(out.fileno())
        os.chmod(temporary, 0o700 if target.suffix == '.py' else 0o600)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument('--directory', required=True, type=Path)
    p.add_argument('--source', type=Path, default=Path(__file__).resolve().parent)
    p.add_argument('--apply', action='store_true')
    a = p.parse_args(argv)
    if os.getuid() == 0: raise SystemExit('Run as the existing node service user, not root')
    dest = a.directory
    if dest.is_symlink() or not dest.is_dir() or dest.stat().st_uid != os.getuid() or dest.stat().st_mode & 0o022:
        raise SystemExit('Existing private node directory required')
    path = dest / 'node-config.json'
    if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise SystemExit('Existing private node config required')
    previous = json.loads(path.read_text())
    config, conda_origin = upgraded_config(previous, dest / 'sandbox-runner.py', DATASET_ROOT)
    config['hostRoot'], host_root_origin = preserved_host_root(previous, dest)
    files = ('dataset-cache.py', 'dataset-upload.py', 'sandbox-runner.py', 'node-executor.py')
    for name in files:
        source = a.source / name
        if not source.is_file() or source.is_symlink(): raise SystemExit('Missing deployment file: '+name)
        compile(source.read_text(), str(source), 'exec')
    spec = importlib.util.spec_from_file_location('gpuq_dataset_cache', a.source / 'dataset-cache.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    module._data2_mount()
    cache_root = DATASET_ROOT
    if cache_root.is_symlink() or cache_root.stat().st_uid != os.getuid() or cache_root.stat().st_mode & 0o077:
        raise SystemExit('Prepare /data2/datasets for this service UID before upgrading')
    if '--ro-bind-fd' not in subprocess.run(['bwrap','--help'],check=True,capture_output=True,text=True).stdout:
        raise SystemExit('bubblewrap --ro-bind-fd support is required')
    if not a.apply:
        print(json.dumps({'dryRun': True, 'files': list(files), 'datasetsRoot': str(cache_root), 'conda': config['conda'], 'condaSource': conda_origin, 'hostRoot': config['hostRoot'], 'hostRootSource': host_root_origin, 'terminalHelperUnchanged': True, 'schedulerUnchanged': True})); return
    module.DatasetCache(root=str(cache_root))
    backup = dest / ('before-datasets-' + str(time.time_ns())); backup.mkdir(mode=0o700)
    for name in (*files, 'node-config.json'):
        old = dest / name
        if old.exists(): shutil.copy2(old, backup / name)
    # Add the backwards-compatible config fields BEFORE installing a runner
    # that reads cfg['conda']. Old runners ignore them; in-flight old jobs keep
    # their process, workspace and GPUQ state. Install the new executor last so
    # dataset submissions are accepted only after its dependencies are present.
    fd, pending = tempfile.mkstemp(prefix='.dataset-config-', dir=dest)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(config, out, indent=2); out.flush(); os.fsync(out.fileno())
        os.chmod(pending, 0o600); os.replace(pending, path)
    finally:
        if os.path.exists(pending): os.unlink(pending)
    directory=os.open(dest,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)
    for name in files: atomic_copy(a.source / name, dest / name)
    directory=os.open(dest,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)
    print(json.dumps({'upgraded': True, 'backup': str(backup), 'conda': config['conda'], 'condaSource': conda_origin, 'hostRoot': config['hostRoot'], 'hostRootSource': host_root_origin, 'terminalHelperUnchanged': True, 'schedulerUnchanged': True, 'restartRequired': False}))

if __name__ == '__main__': main()
