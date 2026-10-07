#!/usr/bin/python3
"""Inspect dedicated HDD/SSD roots; --initialize only creates missing empty roots.

Never changes node-config, mounts, existing owners, datasets, services or quotas.
Review the printed personalStorage fragment and activate it separately.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess


def load():
    spec=importlib.util.spec_from_file_location('personal_layout_plan',Path(__file__).with_name('storage-layout.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


def plan(hdd,ssd,uid,reserve_hdd,reserve_ssd,*,initialize=False):
    if initialize:
        if os.geteuid()!=0:raise ValueError('--initialize requires root')
        # Validate BOTH exact targets before creating either directory.
        preview=plan(hdd,ssd,uid,reserve_hdd,reserve_ssd)
        layout=load()
        for tier in ('hdd','ssd'):
            definition=preview['personalStorage'][tier]
            if definition['rootInode'] is not None:continue
            root=Path(definition['root'])
            active=layout.data_mount(root,layout.read_mounts())
            if active['target']!=definition['mountPoint']:raise ValueError('Backing mount changed since preflight')
            source=Path(active['source'])
            current_uuid=subprocess.check_output(['/usr/sbin/blkid','-s','UUID','-o','value',str(source)],text=True,timeout=5).strip()
            if current_uuid!=definition['filesystemUuid']:raise ValueError('Backing filesystem changed since preflight')
            layout.real_directory_chain(root,missing_leaf=True)
            layout.trusted_parents(root,(uid,))
            root.mkdir(mode=0o700)
            os.chown(root,uid,-1,follow_symlinks=False)
        result=plan(hdd,ssd,uid,reserve_hdd,reserve_ssd)
        result['dryRun']=False
        return result
    layout=load();mounts=layout.read_mounts();roots={}
    if type(uid) is not int or uid<=0 or uid>=2**31:raise ValueError('Use the pinned non-root service UID')
    for tier,raw,reserve in (('hdd',hdd,reserve_hdd),('ssd',ssd,reserve_ssd)):
        if type(reserve) is not int or reserve<0 or reserve>=2**63:raise ValueError('Invalid reserve bytes')
        root=layout.safe_path(raw)
        exists=layout.real_directory_chain(root,missing_leaf=True)
        layout.trusted_parents(root,(uid,))
        current=layout.data_mount(root,mounts)
        if str(root)==current['target']:raise ValueError('Use a dedicated subdirectory, never the entire disk')
        source=Path(current['source'])
        if not stat.S_ISBLK(source.stat().st_mode):raise ValueError('Backing source is not a block device')
        rotation=subprocess.check_output(['/usr/bin/lsblk','-dn','-o','ROTA',str(source)],text=True,timeout=5).strip()
        if rotation!=('1' if tier=='hdd' else '0'):raise ValueError('Disk media type does not match '+tier)
        filesystem_uuid=subprocess.check_output(['/usr/sbin/blkid','-s','UUID','-o','value',str(source)],text=True,timeout=5).strip()
        if not filesystem_uuid or any(c.isspace() for c in filesystem_uuid):raise ValueError('Filesystem UUID is unavailable')
        if exists:
            info=root.lstat()
            if info.st_uid!=uid or stat.S_IMODE(info.st_mode)!=0o700:raise ValueError('Existing root must already be service-owned mode0700; no ownership changed')
        else:info=None
        roots[tier]={'root':str(root),'mountPoint':current['target'],'filesystemUuid':filesystem_uuid,
                     'rootInode':info.st_ino if info else None,'reserveBytes':reserve}
    if roots['hdd']['filesystemUuid']==roots['ssd']['filesystemUuid']:raise ValueError('HDD and SSD must be distinct physical filesystems')
    return {'dryRun':not initialize,'personalStorage':{'enabled':False,**roots},
            'readyToConfigure':all(v['rootInode'] is not None for v in roots.values()),
            'note':'Review volumes, reserves, quota roots and full runtime first. No config, mount, service or existing data changed.'}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hdd-root',required=True);parser.add_argument('--ssd-root',required=True)
    parser.add_argument('--service-uid',type=int,required=True)
    parser.add_argument('--hdd-reserve-gib',type=int,default=256)
    parser.add_argument('--ssd-reserve-gib',type=int,default=256)
    parser.add_argument('--initialize',action='store_true')
    args=parser.parse_args()
    try:
        print(json.dumps(plan(args.hdd_root,args.ssd_root,args.service_uid,args.hdd_reserve_gib*1024**3,
                             args.ssd_reserve_gib*1024**3,initialize=args.initialize),indent=2));return 0
    except (ValueError,OSError,subprocess.SubprocessError) as error:
        print(json.dumps({'error':str(error),'note':'No data moved or deleted; inspect any explicitly initialized empty roots.'}));return 1


if __name__=='__main__':raise SystemExit(main())
