#!/usr/bin/python3
"""First-install managed OCI controls; dry-run by default, no package/mount/service actions.

Provision compatible Podman/crun/uidmap/slirp4netns separately. This tool pins
already-installed binaries and a reviewed NVIDIA CDI JSON, then creates only
the fixed root-owned policy files. It never enables a node feature or pulls an
image. Actual rootless, EDQUOT, cancellation and allocated-GPU tests are required
before the returned candidate node configuration is enabled.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess

HERE = Path(__file__).resolve().parent
def module(name):
    spec = importlib.util.spec_from_file_location('oci_install_'+name, HERE/(name+'.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value
o = module('personal-oci')
q = module('configure-storage-quota')
CONTROL = Path('/etc/gpuq-console/personal-oci-install')


def sha(raw): return hashlib.sha256(raw).hexdigest()


def plan(base_image, cdi_raw):
    o.need(isinstance(base_image, str) and o.BASE.fullmatch(base_image), 'Base image must be a fully qualified immutable digest')
    o.need(len(cdi_raw) <= 4*1024**2, 'Oversized CDI specification')
    cdi = json.loads(cdi_raw)
    names = [v.get('name') for v in cdi.get('devices', [])]
    selected = [v for v in names if isinstance(v,str) and o.GPU.fullmatch(v)]
    o.cdi_devices(cdi_raw, selected)
    binaries = {}
    for path in ('/usr/bin/podman','/usr/bin/crun','/usr/bin/newuidmap','/usr/bin/newgidmap','/usr/bin/slirp4netns'):
        raw = Path(path).read_bytes(); digest = sha(raw)
        o.protected_file(path, digest, executable=True); binaries[path] = digest
    # Metadata only: no graphroot, pull or container creation. Version alone
    # does not establish support for a strong CDI directory override.
    version = subprocess.run(['/usr/bin/podman','--version'], env={'PATH':'/usr/bin:/bin'},
                             text=True, capture_output=True, check=True, timeout=5).stdout.strip()
    match = re.fullmatch(r'podman version (\d+)\.(\d+)\.(\d+)(?:[+~-].*)?', version)
    o.need(match and tuple(map(int,match.groups())) >= (4,1,0), 'Podman >= 4.1 is required; older packages cannot use this GPU contract')
    help_text = subprocess.run(['/usr/bin/podman','--help'], env={'PATH':'/usr/bin:/bin'},
                               text=True, capture_output=True, check=True, timeout=5).stdout
    o.need(len(help_text) <= 1024**2 and any(line.strip().startswith('--cdi-spec-dir ')
           for line in help_text.splitlines()), 'Podman --cdi-spec-dir support is required')
    node = {'enabled': True, 'baseImage': base_image, 'podmanSHA256': binaries['/usr/bin/podman'],
            'runtimeSHA256': binaries['/usr/bin/crun'], 'cdiSHA256': sha(cdi_raw)}
    manifest = {'schema':1,'phase':'DRY_RUN','personalOciCandidate':node,'binariesSHA256':binaries,
                'engineSHA256':sha(o.ENGINE_RAW),'gpuUUIDs':selected,
                'signaturePolicySHA256':sha(o.signature_policy_raw(base_image)),
                'featuresEnabled':False,'packagesInstalled':False,'servicesStarted':False,'mountsChanged':False}
    manifest['planSHA256'] = sha(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode())
    return manifest


def execute(base_image, cdi_raw, approved):
    o.need(os.geteuid()==0, 'Administrator execution required')
    o.need(Path('/etc/gpuq-console-maintenance').is_file(), 'Persistent maintenance fence is required')
    value = plan(base_image,cdi_raw)
    o.need(value['planSHA256']==approved, 'Approved OCI dependency plan changed')
    for path in (CONTROL,o.ENGINE,o.CDI,o.HOOKS,o.SIGNATURE_POLICY):
        o.need(not path.exists() and not path.is_symlink(), 'OCI control path already exists; partial installation must not replay')
    for path in (o.ENGINE.parent,o.CDI.parent):
        q.protected_directory(path)
    o.need(not os.listdir(o.CDI.parent), 'Other dedicated CDI specifications must be independently reviewed, not overwritten')
    q.protected_directory(CONTROL)
    q.put_new(CONTROL/'intent.json',json.dumps(value,sort_keys=True).encode(),0o600)
    q.protected_directory(o.HOOKS)
    q.put_new(o.ENGINE,o.ENGINE_RAW,0o644)
    q.put_new(o.SIGNATURE_POLICY,o.signature_policy_raw(base_image),0o444)
    q.put_new(o.CDI,cdi_raw,0o644)
    value['phase']='OCI_CONTROLS_INSTALLED_FEATURE_DISABLED'
    q.put_new(CONTROL/'receipt.json',json.dumps(value,sort_keys=True).encode(),0o600)
    return value


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-image',required=True);parser.add_argument('--cdi-json',required=True)
    parser.add_argument('--execute',action='store_true');parser.add_argument('--approved-plan-sha256')
    args=parser.parse_args(argv);raw=Path(args.cdi_json).read_bytes()
    print(json.dumps(execute(args.base_image,raw,args.approved_plan_sha256) if args.execute else plan(args.base_image,raw),sort_keys=True))


if __name__=='__main__':main()
