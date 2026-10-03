#!/usr/bin/python3
"""Local Unix socket -> fixed SSH forced commands. No public listener or shell."""
import json, os, socketserver, subprocess
from pathlib import Path
BASE=Path('/opt/gpuq-console/executor')
HOSTS={n['id']:n for n in json.loads(Path('/opt/gpuq-console/inventory.json').read_text())['nodes']}
class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(35)
        try:
            data=json.loads(self.rfile.readline(1600001))
            if data['machine'] not in HOSTS or data['operation'] not in ('datasets.storage.status','datasets.storage.plan','datasets.storage.pin','datasets.storage.unpin','transfers.capabilities','transfers.source.prepare','transfers.confirm-source-release','transfers.release-source','transfers.start','transfers.status','transfers.cancel','transfers.resume','datasets.upload.pause','datasets.upload.direct-ticket','datasets.upload.direct-revoke','sync','cancel','logs','diagnostics','watch','priority','host.exec','host.status','host.cancel','files.list','files.put','files.get','terminal.open','terminal.exchange','terminal.close','terminal.detach','datasets.capacity','datasets.list','datasets.status','datasets.prepare','datasets.register','datasets.unregister','datasets.upload.begin','datasets.upload.manifest','datasets.upload.seal','datasets.upload.status','datasets.upload.chunk','datasets.upload.commit','datasets.upload.discard','datasets.workspace.list','datasets.workspace.put','datasets.workspace.get','datasets.workspace.status','datasets.workspace.publish','datasets.import.start','datasets.import.status','datasets.import.list','datasets.import.cancel','datasets.import.discard','projects.list','projects.create','projects.status','projects.publish','projects.verify','projects.snapshot.info','projects.snapshot.manifest','projects.snapshot.get','datasets.snapshot.info','datasets.snapshot.manifest','datasets.snapshot.get','projects.sync.begin','projects.sync.manifest','projects.sync.seal','projects.sync.status','projects.sync.chunk','projects.sync.finish'): raise ValueError('Invalid operation')
            host=HOSTS[data['machine']]
            p=subprocess.run(['/usr/bin/ssh','-F','/dev/null','-T','-o','BatchMode=yes','-o','ConnectTimeout=5','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-o',f'UserKnownHostsFile={BASE}/known_hosts','-i',str(BASE/'id_ed25519'),host['user']+'@'+host['address']],input=json.dumps({'operation':data['operation'],'args':data['args']}),text=True,capture_output=True,timeout=27)
            if p.returncode: raise ValueError('Node connection failed')
            result=json.loads(p.stdout)
        except Exception as e: result={'ok':False,'error':str(e)[:200]}
        self.wfile.write((json.dumps(result)+'\n').encode())
class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads=True
if __name__=='__main__':
    os.umask(0o007)
    sock='/run/gpuq-console-executor/bridge.sock'
    if os.path.exists(sock):os.unlink(sock)
    with Server(sock,Handler) as server:
        os.chmod(sock,0o660);os.chown(sock,0,1000);server.serve_forever()
