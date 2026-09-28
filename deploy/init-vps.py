#!/usr/bin/env python3
"""Prepare new-install directories/keys/units, without starting or stopping services."""
import json,os,secrets,shutil,subprocess
from pathlib import Path
if os.getuid()!=0:raise SystemExit('Run as root on the VPS after reviewing inventory.json')
base=Path('/opt/amax-console')
if Path(__file__).resolve().parents[1]!=base:raise SystemExit('Clone the repository into /opt/amax-console first')
json.loads((base/'inventory.json').read_text())
os.umask(0o077)
for folder,mode,uid,gid in [('data',0o700,1000,1000),('status',0o750,0,1000),('backups',0o700,0,0),('collector',0o700,0,0),('executor',0o700,0,0)]:
    path=base/folder;path.mkdir(exist_ok=True);path.chmod(mode);os.chown(path,uid,gid)
bootstrap=base/'data/bootstrap.json'
if not (base/'data/portal.sqlite').exists() and not bootstrap.exists():
    bootstrap.write_text(json.dumps({'username':'admin','password':secrets.token_urlsafe(30)}));bootstrap.chmod(0o600);os.chown(bootstrap,1000,1000)
for folder,script in [('collector','collect-status.py'),('executor','execution-worker.py')]:
    shutil.copy2(base/'deploy'/script,base/folder/script)
    key=base/folder/'id_ed25519'
    if not key.exists():subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-C','amax-console-'+folder,'-f',str(key)],check=True)
    known=base/folder/'known_hosts'
    if not known.exists():known.touch(mode=0o600)
for unit in (base/'deploy').glob('amax-console-*.service'):shutil.copy2(unit,Path('/etc/systemd/system')/unit.name)
for unit in (base/'deploy').glob('amax-console-*.timer'):shutil.copy2(unit,Path('/etc/systemd/system')/unit.name)
shutil.copy2(base/'deploy/backup.sh',base/'backup.sh');(base/'backup.sh').chmod(0o700)
subprocess.run(['systemctl','daemon-reload'],check=True)
print('Prepared. Read data/bootstrap.json locally; pin node host keys before enabling services. No network/ACL/GPUQ services changed.')
