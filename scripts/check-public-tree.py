#!/usr/bin/env python3
"""Fail CI on tracked runtime data, private keys, or obvious credential literals."""
import re,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
paths=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0')
bad=[]
private_dirs={'.deployment-private','data','status','backups','collector','executor','generated','node_modules','__pycache__','review-artifacts'}
patterns=[re.compile(rb'-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----'),re.compile(rb'hskey-(?:auth|api)-[A-Za-z0-9_-]{16,}'),re.compile(rb'gh[pousr]_[A-Za-z0-9]{30,}')]
for name in filter(None,paths):
    p=Path(name)
    if any(part in private_dirs for part in p.parts) or p.name in {'.env','inventory.json','known_hosts'} or p.suffix in {'.sqlite','.pem','.key','.invite-key','.pyc'} or p.name.startswith('id_ed25519'):
        bad.append((name,'private/runtime file'));continue
    raw=(root/p).read_bytes()
    if any(pattern.search(raw) for pattern in patterns):bad.append((name,'credential-like content'))
for name,reason in bad:print(f'{name}: {reason}',file=sys.stderr)
if bad:raise SystemExit(1)
print(f'Public tree checks passed ({len(list(filter(None,paths)))} tracked files). Review and a secret scanner are still required.')
