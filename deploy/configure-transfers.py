#!/usr/bin/env python3
"""Explicit opt-in after runtime upgrade. Default dry run, never restart GPUQ."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import shutil
import ssl
import stat
import subprocess
import time
import node_runtime

HERE=Path(__file__).resolve().parent


def private_file(path):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1 or info.st_mode&0o077:
        raise ValueError('Use a service-owned mode-0600 regular file: '+str(path))
    return path.read_bytes()


def configure(args):
    if os.getuid()==0:raise ValueError('Run as the existing GPUQ service user, not root')
    directory=args.program_dir.resolve();config_path=directory/'node-config.json'
    previous=json.loads(private_file(config_path));settings=json.loads(private_file(args.peer_config))
    if not isinstance(settings,dict) or not settings or set(settings)-{'transferPeer','transferPeers'}:
        raise ValueError('Only transferPeer/transferPeers settings may be changed')
    # All runtime dependencies must already be installed, on either profile.
    profile=node_runtime.detected_profile((directory/'sandbox-runner.py').read_bytes())
    installed={name:(directory/name).read_bytes() for name,_ in node_runtime.runtime_plan(profile)}
    node_runtime.validate_dependencies(installed)
    for name in ('transfer-jobs.py','transfer-peer.py'):
        if installed[name]!=(HERE/name).read_bytes():raise ValueError('Upgrade complete node runtime first: '+name)
    if b'--transfer-peer-daemon' not in installed['node-executor.py']:raise ValueError('Upgrade node executor first')
    if 'transferPeers' in settings:
        import importlib.util
        spec=importlib.util.spec_from_file_location('configure_transfer_client',HERE/'transfer-jobs.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        if not isinstance(settings['transferPeers'],dict):raise ValueError('transferPeers must be a machine-ID map')
        for name,value in settings['transferPeers'].items():
            if not isinstance(name,str) or not name or len(name)>64:raise ValueError('Invalid peer machine ID')
            module.PeerClient(value,{}).close()
    certificate_pin=None
    if 'transferPeer' in settings:
        peer=settings['transferPeer']
        if not isinstance(peer,dict) or set(peer)!={'bind','port','certificate','privateKey'}:raise ValueError('Invalid listener config')
        address=ipaddress.IPv4Address(peer['bind'])
        if not address.is_private or address.is_unspecified or address.is_multicast or type(peer['port']) is not int or not 1024<=peer['port']<=65535:raise ValueError('Use an explicit LAN address and port >=1024')
        for key in ('certificate','privateKey'):
            path=Path(peer[key]);
            if not path.is_absolute():raise ValueError('TLS files need absolute paths')
            private_file(path)
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(peer['certificate'],peer['privateKey'])
        certificate_pin=hashlib.sha256(ssl.PEM_cert_to_DER_cert(Path(peer['certificate']).read_text())).hexdigest()
    if args.enable_peer and 'transferPeer' not in settings and 'transferPeer' not in previous:raise ValueError('Source listener settings are required')
    if args.enable_peer and not args.apply:raise ValueError('--enable-peer requires --apply')
    updated={**previous,**settings}
    plan={'dryRun':not args.apply,'machine':previous.get('machine'),'certificateSha256':certificate_pin,
          'listener':settings.get('transferPeer',{}).get('bind'),'peers':list(settings.get('transferPeers',{})),
          'enablePeer':args.enable_peer,'gpuqUnchanged':True}
    if args.apply:
        environment={**os.environ,'XDG_RUNTIME_DIR':f'/run/user/{os.getuid()}'}
        def run(*argv):return subprocess.run(['/usr/bin/systemctl','--user',*argv],env=environment,check=True,text=True,capture_output=True,timeout=10)
        if 'transferPeer' in settings and previous.get('transferPeer')!=settings['transferPeer']:
            active=subprocess.run(['/usr/bin/systemctl','--user','is-active','--quiet','gpuq-transfer-peer.service'],env=environment,timeout=5).returncode
            if active==0:raise ValueError('Stop ONLY gpuq-transfer-peer.service before changing a live listener; GPUQ stays running')
        backup=directory/('node-config.before-transfers-'+str(time.time_ns())+'.json');shutil.copy2(config_path,backup);backup.chmod(0o600)
        node_runtime.atomic_install(json.dumps(updated,indent=2).encode(),config_path);config_path.chmod(0o600)
        units=Path.home()/'.config/systemd/user';units.mkdir(parents=True,exist_ok=True)
        node_runtime.atomic_install((HERE/'gpuq-transfer-peer.service').read_bytes(),units/'gpuq-transfer-peer.service')
        run('daemon-reload')
        if args.enable_peer:run('enable','--now','gpuq-transfer-peer.service')
        plan['backup']=str(backup)
    return plan


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--peer-config',type=Path,required=True);parser.add_argument('--program-dir',type=Path,default=Path.home()/'.local/libexec/gpuq-console');parser.add_argument('--apply',action='store_true');parser.add_argument('--enable-peer',action='store_true')
    try:print(json.dumps(configure(parser.parse_args())))
    except (ValueError,OSError,subprocess.SubprocessError) as error:raise SystemExit(str(error))
