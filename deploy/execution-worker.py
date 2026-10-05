#!/usr/bin/python3
"""Local Unix socket -> fixed SSH forced commands. No public listener or shell."""
import hashlib, ipaddress, json, os, re, socketserver, stat, subprocess, threading, time
from pathlib import Path
BASE=Path('/opt/gpuq-console/executor')
HOSTS={n['id']:n for n in json.loads(Path('/opt/gpuq-console/inventory.json').read_text())['nodes']}
RUNTIME=Path('/run/gpuq-console-executor')

class SSHConnections:
    """Fixed-host transport; only creation of an idle master is serialized.

    Control channels carry no operation or input. Each RPC is sent once, even
    if the connection breaks. Idle masters exit after 15 seconds; all sessions
    still execute the same key's forced command on the node.
    """
    def __init__(self, base=BASE, runtime=RUNTIME):
        self.base=base;self.runtime=runtime;self.locks={};self.slots={};self.guard=threading.Lock()

    def identity(self, host):
        user=host['user'];address=host['address']
        if not isinstance(user,str) or not re.fullmatch(r'[a-z_][a-z0-9_-]{0,63}\$?',user):
            raise ValueError('Invalid fixed host')
        try:ipaddress.ip_address(address)
        except (TypeError,ValueError):raise ValueError('Invalid fixed host')
        name=hashlib.sha256(json.dumps([user,address,22,str(self.base)],separators=(',',':')).encode()).hexdigest()[:24]
        with self.guard:
            lock=self.locks.setdefault(name,threading.Lock())
            slots=self.slots.setdefault(name,threading.BoundedSemaphore(8))
        return name,user+'@'+address,lock,slots

    def control_path(self, name):
        parent=os.open(self.runtime,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            s=os.fstat(parent)
            if s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)&0o022:
                raise ValueError('Unsafe SSH runtime directory')
            try:os.mkdir('ssh-mux',0o700,dir_fd=parent)
            except FileExistsError:pass
            private=os.open('ssh-mux',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
            try:
                s=os.fstat(private)
                if s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o700:
                    raise ValueError('Unsafe SSH control directory')
                current=(self.runtime/'ssh-mux').lstat()
                if (s.st_dev,s.st_ino)!=(current.st_dev,current.st_ino):
                    raise ValueError('SSH control directory changed')
            finally:os.close(private)
        finally:os.close(parent)
        path=self.runtime/'ssh-mux'/('c-'+name)
        if len(os.fsencode(path))>100:raise ValueError('SSH control path too long')
        return path

    def socket_identity(self, path):
        try:s=path.lstat()
        except FileNotFoundError:return None
        if not stat.S_ISSOCK(s.st_mode) or s.st_uid!=os.getuid() or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)&0o077:
            raise ValueError('Unsafe SSH control socket')
        return s.st_dev,s.st_ino

    def command(self, target, path):
        return ['/usr/bin/ssh','-F','/dev/null','-T','-o','BatchMode=yes','-o','ConnectionAttempts=1',
            '-o','ConnectTimeout=5','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes',
            '-o',f'UserKnownHostsFile={self.base}/known_hosts','-i',str(self.base/'id_ed25519'),
            '-o','ForwardAgent=no','-o','ForwardX11=no','-o','ClearAllForwardings=yes',
            '-o','ServerAliveInterval=5','-o','ServerAliveCountMax=1','-o','ControlMaster=no',
            '-o',f'ControlPath={path}',target]

    def ensure_master(self, target, path, deadline):
        identity=self.socket_identity(path);command=self.command(target,path)
        if identity is not None:
            checked=subprocess.run(command[:-1]+['-O','check',target],capture_output=True,timeout=min(2,max(0.01,deadline-time.monotonic())))
            if checked.returncode==0:return
            # Never remove a live, unrecognized or concurrently replaced socket.
            if not any(word in checked.stderr for word in (b'Connection refused',b'No such file or directory')):
                raise ValueError('Node connection failed')
            if self.socket_identity(path)==identity:path.unlink()
            elif self.socket_identity(path) is not None:raise ValueError('SSH control socket changed')
        remaining=deadline-time.monotonic()
        if remaining<=0:raise ValueError('Node connection failed')
        # No remote command, forwarding or stdin is requested by this startup.
        master=command[:-1]+['-N','-f','-o','ControlPersist=15s',target]
        master[master.index('ControlMaster=no')]='ControlMaster=yes'
        started=subprocess.run(master,stdin=subprocess.DEVNULL,capture_output=True,timeout=min(7,remaining))
        if started.returncode or self.socket_identity(path) is None:raise ValueError('Node connection failed')

    def rpc_command(self, target, path):
        # If a warm socket disappears/refuses, fail instead of implicitly
        # making another network connection. A future request may reconnect.
        return self.command(target,path)[:-1]+['-o','ProxyCommand=/usr/bin/false',target]

    def call(self, host, request):
        name,target,lock,slots=self.identity(host);deadline=time.monotonic()+27
        if not slots.acquire(timeout=27):raise ValueError('Node connection failed')
        try:
            path=self.control_path(name)
            if not lock.acquire(timeout=max(0,deadline-time.monotonic())):raise ValueError('Node connection failed')
            try:self.ensure_master(target,path,deadline)
            finally:lock.release()
            remaining=deadline-time.monotonic()
            if remaining<=0:raise ValueError('Node connection failed')
            # Never retry or resend input after a timeout or failed channel.
            return subprocess.run(self.rpc_command(target,path),input=json.dumps(request),text=True,capture_output=True,timeout=remaining)
        except (OSError,subprocess.SubprocessError):raise ValueError('Node connection failed') from None
        finally:slots.release()

SSH_CONNECTIONS=SSHConnections()
INTERNAL_STORAGE=('storage.archive.events','storage.archive.ack','storage.archive.original',
    'storage.archive.provision','storage.archive.certify','storage.lease.prepare','storage.lease.cancel',
    'storage.download.open','storage.download.info','storage.download.manifest','storage.download.get','storage.download.finish')
CLOUD_FILES=tuple('datasets.cloud.'+action for action in ('info','list','status','upload','verify','download','cancel'))
INTERNAL_STORAGE+=CLOUD_FILES
class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(35)
        try:
            data=json.loads(self.rfile.readline(1600001))
            if data['machine'] not in HOSTS or data['operation'] not in INTERNAL_STORAGE+('datasets.storage.status','datasets.storage.plan','datasets.storage.pin','datasets.storage.unpin','transfers.capabilities','transfers.source.prepare','transfers.confirm-source-release','transfers.release-source','transfers.start','transfers.status','transfers.cancel','transfers.resume','datasets.upload.pause','datasets.upload.direct-ticket','datasets.upload.direct-revoke','sync','cancel','logs','diagnostics','watch','priority','host.exec','host.status','host.cancel','files.list','files.put','files.get','terminal.open','terminal.exchange','terminal.close','terminal.detach','datasets.capacity','datasets.list','datasets.status','datasets.prepare','datasets.register','datasets.unregister','datasets.upload.begin','datasets.upload.manifest','datasets.upload.seal','datasets.upload.status','datasets.upload.chunk','datasets.upload.commit','datasets.upload.discard','datasets.workspace.list','datasets.workspace.put','datasets.workspace.get','datasets.workspace.status','datasets.workspace.publish','datasets.import.start','datasets.import.status','datasets.import.list','datasets.import.cancel','datasets.import.discard','projects.list','projects.quota','projects.create','projects.status','projects.publish','projects.verify','projects.snapshot.info','projects.snapshot.manifest','projects.snapshot.get','datasets.snapshot.info','datasets.snapshot.manifest','datasets.snapshot.get','projects.sync.begin','projects.sync.manifest','projects.sync.seal','projects.sync.status','projects.sync.chunk','projects.sync.finish'): raise ValueError('Invalid operation')
            host=HOSTS[data['machine']]
            p=SSH_CONNECTIONS.call(host,{'operation':data['operation'],'args':data['args']})
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
