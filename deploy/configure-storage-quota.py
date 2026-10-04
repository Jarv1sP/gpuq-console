#!/usr/bin/python3
"""Offline administrator installer; default is read-only plan, never remount.

First enable project-quota enforcement on the intended DATA filesystems during
an approved maintenance window. This tool installs finite limits and a narrow
root broker, not packages, filesystems, node feature flags or services. Existing
nonempty user trees must already have been migrated/verified separately.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import stat
import subprocess
import sys
import uuid

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('gpuq_quota_setup', HERE/'storage-quota.py')
q = importlib.util.module_from_spec(spec); spec.loader.exec_module(q)
LIB = Path('/usr/local/lib/gpuq-storage-quota')
SUDOERS = Path('/etc/sudoers.d/gpuq-storage-quota')


def sha(raw): return hashlib.sha256(raw).hexdigest()


def protected_directory(path):
    try:
        path.mkdir(mode=0o755)
        path.chmod(0o755)  # A maintenance umask may be 077.
    except FileExistsError:
        pass
    with q.directory(path) as fd:
        info = os.fstat(fd)
        q.need(info.st_uid == 0 and not info.st_mode & 0o022, 'Installer parent must be root protected')
        os.fsync(fd)
    with q.directory(path.parent) as parent: os.fsync(parent)
    return path


def put_new(path, raw, mode):
    """No overwrite; a partial installation remains inspectable, not replayed."""
    with q.directory(path.parent) as parent:
        fd = os.open(path.name, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, mode, dir_fd=parent)
        try:
            os.fchmod(fd, mode)
            view = memoryview(raw)
            while view:
                count = os.write(fd, view)
                q.need(count > 0, 'Short installer write'); view = view[count:]
            os.fsync(fd)
        finally: os.close(fd)
        os.fsync(parent)


def plan(policy):
    policy = q.validate_policy(policy)
    name = pwd.getpwuid(policy['serviceUid']).pw_name
    q.need(name not in ('root', 'nobody') and name.replace('_','').replace('-','').isalnum(), 'Unsafe service account')
    limits = []
    for owner, row in policy['owners'].items():
        for key, expected in row['limits'].items():
            volume, device = q.volume_for(policy, policy['volumes'][key]['mountPoint'])
            q.need(volume == key, 'Configured quota mount is not the expected filesystem')
            current = q.quotactl(device, row['projectId'])
            q.need(current == {'bytes': 0, 'inodes': 0, 'usedBytes': 0, 'usedInodes': 0},
                   'Project ID is already used; this first-install tool will not reassign it')
            limits.append({'owner': owner, 'volume': key, 'projectId': row['projectId'],
                           'device': str(device), 'before': current, 'after': expected})
    files = {name: (HERE/name).read_bytes() for name in ('storage-quota.py', 'platform-root-guard.py')}
    wrapper = ('#!/bin/sh\nexec /usr/bin/python3 -I '+str(LIB/'storage-quota.py')+'\n').encode()
    sudoers = (name+' ALL=(root) NOPASSWD: '+q.BROKER+' ""\n').encode()
    return {'schema': 1, 'phase': 'DRY_RUN', 'policySHA256': sha(json.dumps(policy, sort_keys=True).encode()),
            'serviceUser': name, 'limits': limits, 'filesSHA256': {k: sha(v) for k,v in files.items()},
            'wrapperSHA256': sha(wrapper), 'sudoersSHA256': sha(sudoers),
            'nodeConfigurationChanged': False, 'mountsChanged': False, 'servicesStarted': False}, files, wrapper, sudoers


def execute(policy, approved_sha):
    q.need(os.geteuid() == 0, 'Installer requires explicit administrator execution')
    # No application starts, metadata migrations or guessed owner mappings.
    q.need(Path('/etc/gpuq-console-maintenance').is_file(), 'Persistent maintenance fence is required')
    q.need(not any(p.exists() or p.is_symlink() for p in (LIB, q.POLICY, Path(q.BROKER), SUDOERS)),
           'Installation path exists; inspect partial/previous state instead of replaying')
    result, files, wrapper, sudoers = plan(policy)
    q.need(result['policySHA256'] == approved_sha, 'Approved policy changed')
    for path in (LIB.parent, Path(q.BROKER).parent, q.POLICY.parent):
        protected_directory(path)
    protected_directory(LIB)
    intent = LIB/'intent.json'
    put_new(intent, json.dumps(result, sort_keys=True).encode(), 0o600)
    for item in result['limits']:
        q.quotactl(item['device'], item['projectId'], item['after'])
        actual = q.quotactl(item['device'], item['projectId'])
        q.need(all(actual[key] == item['after'][key] for key in ('bytes', 'inodes')), 'Kernel limit readback mismatch')
    for name, raw in files.items(): put_new(LIB/name, raw, 0o644)
    put_new(q.POLICY, json.dumps(policy, sort_keys=True).encode(), 0o600)
    put_new(Path(q.BROKER), wrapper, 0o755)
    staged = LIB/'sudoers.candidate'
    put_new(staged, sudoers, 0o440)
    subprocess.run(['/usr/sbin/visudo', '-cf', str(staged)], check=True, capture_output=True, timeout=10)
    put_new(SUDOERS, sudoers, 0o440)
    # Deliberately do not enable storageQuota / personalOci here. The real
    # EDQUOT + container/cancel/assigned-GPU acceptance comes first.
    result.update(phase='LIMITS_AND_BROKER_INSTALLED_FEATURES_DISABLED')
    put_new(LIB/'receipt.json', json.dumps(result, sort_keys=True).encode(), 0o600)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--policy', required=True)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--approved-policy-sha256')
    args = parser.parse_args(argv)
    policy = json.loads(Path(args.policy).read_bytes())
    result = execute(policy, args.approved_policy_sha256) if args.execute else plan(policy)[0]
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__': main()
