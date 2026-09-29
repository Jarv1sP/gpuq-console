#!/usr/bin/env python3
"""Fetch the official amd64 Ubuntu build image through this process's proxy.

Produces a docker-load archive; never edits Docker daemon/network settings.
Each manifest/config/layer is verified against its SHA256 descriptor.
Only use on the administrative build host, not from a public API.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import tarfile
import urllib.request

REGISTRY = 'https://registry-1.docker.io/v2/library/ubuntu/'
ACCEPT = ', '.join(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'])

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--directory', required=True)
    a = p.parse_args()
    directory = Path(a.directory).resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    token_url = 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/ubuntu:pull'
    with urllib.request.urlopen(token_url, timeout=60) as response:
        token = json.load(response)['token']
    def request(path):
        return urllib.request.Request(REGISTRY + path, headers={'Authorization': 'Bearer ' + token, 'Accept': ACCEPT})
    def digest_data(data, digest):
        if digest != 'sha256:' + hashlib.sha256(data).hexdigest():
            raise RuntimeError('Content digest mismatch')
    with urllib.request.urlopen(request('manifests/22.04'), timeout=60) as response:
        index_raw = response.read()
    index = json.loads(index_raw)
    descriptor = next(m for m in index['manifests'] if m.get('platform', {}).get('os') == 'linux' and m.get('platform', {}).get('architecture') == 'amd64')
    with urllib.request.urlopen(request('manifests/' + descriptor['digest']), timeout=60) as response:
        manifest_raw = response.read()
    digest_data(manifest_raw, descriptor['digest'])
    manifest = json.loads(manifest_raw)
    def blob(desc):
        path = directory / desc['digest'].split(':')[1]
        if not path.exists():
            temp = path.with_suffix('.partial')
            with urllib.request.urlopen(request('blobs/' + desc['digest']), timeout=120) as response, temp.open('wb') as out:
                shutil.copyfileobj(response, out, 1024 * 1024)
            temp.replace(path)
        sha = hashlib.sha256()
        with path.open('rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                sha.update(chunk)
        if 'sha256:' + sha.hexdigest() != desc['digest']:
            raise RuntimeError('Downloaded blob digest mismatch: ' + path.name)
        return path
    config_path = blob(manifest['config'])
    config = json.loads(config_path.read_text())
    layers = []
    for desc, diff in zip(manifest['layers'], config['rootfs']['diff_ids'], strict=True):
        compressed = blob(desc)
        layer = directory / (diff.split(':')[1] + '.tar')
        opener = gzip.open if desc['mediaType'].endswith(('+gzip', '.gzip')) else open
        sha = hashlib.sha256()
        with opener(compressed, 'rb') as src, layer.open('wb') as out:
            for chunk in iter(lambda: src.read(1024 * 1024), b''):
                sha.update(chunk); out.write(chunk)
        if 'sha256:' + sha.hexdigest() != diff:
            raise RuntimeError('Uncompressed layer digest mismatch')
        layers.append(layer)
    archive = directory / 'ubuntu-22.04-amd64.tar'
    metadata = json.dumps([{'Config': config_path.name + '.json', 'RepoTags': ['ubuntu:22.04'], 'Layers': [l.name for l in layers]}]).encode()
    with tarfile.open(archive, 'w') as tar:
        tar.add(config_path, arcname=config_path.name + '.json')
        for layer in layers: tar.add(layer, arcname=layer.name)
        info = tarfile.TarInfo('manifest.json'); info.size = len(metadata); info.mode = 0o644
        tar.addfile(info, io.BytesIO(metadata))
    result = {'source': 'docker.io/library/ubuntu:22.04', 'manifest': descriptor['digest'], 'archive': str(archive)}
    (directory / 'build-base.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))

if __name__ == '__main__':
    os.umask(0o077)
    main()
