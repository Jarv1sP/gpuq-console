#!/usr/bin/env python3
"""Prepare new-install directories/keys/units, without starting or stopping services."""
import json,os,secrets,shutil,stat,subprocess
from pathlib import Path


def check_file(path, required=True):
    try:
        info=path.lstat()
    except FileNotFoundError:
        if not required:return False
        raise
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:
        raise ValueError('Expected a regular, non-linked management file: '+str(path))
    return True


def secure_file(path, mode=0o600):
    check_file(path)
    os.chown(path,0,0,follow_symlinks=False)
    path.chmod(mode)


def secure_directory(path, mode, uid=0, gid=0):
    if not stat.S_ISDIR(path.lstat().st_mode):
        raise ValueError('Expected a real management directory: '+str(path))
    os.chown(path,uid,gid,follow_symlinks=False)
    path.chmod(mode)


def prepare_layout(base):
    # A tarball may carry its creator's UID/mode. CAP_CHOWN-only collectors
    # cannot bypass another owner's 0700 tree, even though their UID is root.
    secure_directory(base,0o755)
    secure_file(base/'inventory.json')
    json.loads((base/'inventory.json').read_text())
    for folder,mode,uid,gid in [('data',0o700,1000,1000),('status',0o750,0,1000),('backups',0o700,0,0),('collector',0o700,0,0),('executor',0o700,0,0)]:
        path=base/folder
        if not path.exists() and not path.is_symlink():path.mkdir()
        secure_directory(path,mode,uid,gid)
    # Deliberately no recursive chown/chmod: existing DB/workspace files stay put.


def main():
    if os.getuid()!=0:raise SystemExit('Run as root on the VPS after reviewing inventory.json')
    base=Path('/opt/gpuq-console')
    if Path(__file__).resolve().parents[1]!=base:raise SystemExit('Clone the repository into /opt/gpuq-console first')
    os.umask(0o077)
    prepare_layout(base)
    bootstrap=base/'data/bootstrap.json'
    if not (base/'data/portal.sqlite').exists() and not bootstrap.exists():
        check_file(bootstrap,required=False)
        bootstrap.write_text(json.dumps({'username':'admin','password':secrets.token_urlsafe(30)}));bootstrap.chmod(0o600);os.chown(bootstrap,1000,1000)
    for folder,script in [('collector','collect-status.py'),('executor','execution-worker.py')]:
        source=base/'deploy'/script;target=base/folder/script
        check_file(source);check_file(target,required=False)
        shutil.copy2(source,target);secure_file(target,0o700)
        key=base/folder/'id_ed25519'
        if not check_file(key,required=False):
            check_file(key.with_suffix('.pub'),required=False)
            subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-C','gpuq-console-'+folder,'-f',str(key)],check=True)
        secure_file(key)
        if check_file(key.with_suffix('.pub'),required=False):secure_file(key.with_suffix('.pub'),0o644)
        known=base/folder/'known_hosts'
        if not check_file(known,required=False):known.touch(mode=0o600)
        secure_file(known)
    for unit in (base/'deploy').glob('gpuq-console-*.service'):shutil.copy2(unit,Path('/etc/systemd/system')/unit.name)
    for unit in (base/'deploy').glob('gpuq-console-*.timer'):shutil.copy2(unit,Path('/etc/systemd/system')/unit.name)
    check_file(base/'deploy/backup.sh');check_file(base/'backup.sh',required=False)
    shutil.copy2(base/'deploy/backup.sh',base/'backup.sh');secure_file(base/'backup.sh',0o700)
    subprocess.run(['systemctl','daemon-reload'],check=True)
    print('Prepared. Read data/bootstrap.json locally; pin node host keys before enabling services. No network/ACL/GPUQ services changed.')


if __name__=='__main__':main()
