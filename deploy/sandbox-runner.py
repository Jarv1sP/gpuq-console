#!/usr/bin/python3
"""GPUQ-owned job process. Mount only assigned devices and one user's workspace."""
import hashlib,json,os,re,select,subprocess,sys,time,tempfile
from pathlib import Path
HERE=Path(__file__).resolve().parent

def main():
    jid=sys.argv[1]
    if not re.fullmatch(r'[a-f0-9-]{36}',jid):raise ValueError('Invalid job ID')
    cfg=json.loads((HERE/'node-config.json').read_text());root=Path(cfg['root'])
    terminal=len(sys.argv)>2 and sys.argv[2]=='terminal'
    spec=json.loads((root/('terminals' if terminal else 'jobs')/f'{jid}.json').read_text())
    indices=os.environ.get('GPUQ_ASSIGNED_GPU_INDICES','').split(',')
    uuids=os.environ.get('GPUQ_ASSIGNED_GPU_UUIDS','').split(',')
    if terminal:indices=[];uuids=[]
    elif len(indices)!=spec['cards'] or len(uuids)!=len(indices) or any(not re.fullmatch('[0-9]+',i) for i in indices) or any(not u.startswith('GPU-') for u in uuids):raise ValueError('Missing GPUQ allocation')
    if not terminal:
        memory=subprocess.check_output(['/usr/bin/nvidia-smi','--id',','.join(indices),'--query-gpu=memory.total','--format=csv,noheader,nounits'],text=True)
        sizes=[int(line.strip()) for line in memory.splitlines()]
        if len(sizes)!=len(indices) or any(size<spec.get('minVramGiB',0)*1024-512 for size in sizes):raise ValueError('Allocated GPU memory does not meet request')
    # Apply limits BEFORE any untrusted code runs, inside the original GPUQ unit.
    group=next(line.split(':',2)[2].strip() for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
    unit=group.rsplit('/',1)[-1]
    if not unit.startswith('amax-term-' if terminal else 'gpuq-') or not unit.endswith('.service'):raise ValueError('Not running inside an authorized job unit')
    env={'PATH':'/usr/bin:/bin','HOME':str(Path.home()),'XDG_RUNTIME_DIR':f'/run/user/{os.getuid()}','DBUS_SESSION_BUS_ADDRESS':f'unix:path=/run/user/{os.getuid()}/bus'}
    subprocess.run(['/usr/bin/systemctl','--user','set-property','--runtime',unit,f'MemoryMax={8 if terminal else spec["cards"]*32}G',f'CPUQuota={200 if terminal else spec["cards"]*400}%','TasksMax=2048'],env=env,check=True)
    workspace=root/'users'/hashlib.sha256(spec['userId'].encode()).hexdigest()[:32]
    workspace.mkdir(parents=True,exist_ok=True,mode=0o700)
    # Mount by open FD to pin the directory and avoid a path replacement race.
    workfd=os.open(workspace,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    info_r,info_w=os.pipe();block_r,block_w=os.pipe()
    args=['/usr/bin/bwrap','--unshare-all',*([] if terminal else ['--new-session']),'--die-with-parent','--cap-drop','ALL','--hostname','gpuq-job',
          '--info-fd',str(info_w),'--block-fd',str(block_r),'--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/sbin','/sbin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
          '--proc','/proc','--ro-bind','/proc/driver/nvidia','/proc/driver/nvidia','--ro-bind','/sys','/sys','--dev','/dev','--tmpfs','/dev/shm','--tmpfs','/tmp','--tmpfs','/run','--dir','/etc',
          '--ro-bind','/etc/ld.so.cache','/etc/ld.so.cache','--ro-bind','/etc/alternatives','/etc/alternatives','--ro-bind','/etc/ssl','/etc/ssl',
          '--bind-fd',str(workfd),'/workspace','--chdir','/workspace','--clearenv']
    for source in ([] if terminal else ['/dev/nvidiactl','/dev/nvidia-uvm','/dev/nvidia-uvm-tools']+[f'/dev/nvidia{i}' for i in indices]):
        if not Path(source).exists():raise ValueError('Allocated GPU device missing')
        args+=['--dev-bind',source,source]
    # Read-only Python distribution; host home, SSH keys, sockets and other data are absent.
    conda=cfg['conda'];args+=['--ro-bind',conda,'/opt/conda']
    if conda!='/opt/conda':args+=['--ro-bind',conda,conda]
    # Namespace NUMA support can differ across ranks; force a consistent shared
    # memory backend instead of NCCL's per-rank cuMem-host fallback (2.28.9).
    args+=['--setenv','NCCL_CUMEM_HOST_ENABLE','0']
    if terminal:args+=['--setenv','TERM','xterm-256color','--setenv','PS1',spec['username']+'@'+cfg.get('machine','gpu')+r':\w\$ ']
    # Both names identify the same job so existing training scripts keep working.
    for key,value in {'PATH':'/opt/conda/bin:/usr/bin:/bin','HOME':'/workspace','USER':spec['username'],'LOGNAME':spec['username'],'LANG':'C.UTF-8','PYTHONUNBUFFERED':'1','PYTHONUSERBASE':'/workspace/.local','OMP_NUM_THREADS':'1','SSL_CERT_FILE':'/etc/ssl/certs/ca-certificates.crt','CURL_CA_BUNDLE':'/etc/ssl/certs/ca-certificates.crt','REQUESTS_CA_BUNDLE':'/etc/ssl/certs/ca-certificates.crt','CUDA_VISIBLE_DEVICES':','.join(uuids),'NVIDIA_VISIBLE_DEVICES':','.join(uuids),'GPUQ_JOB_ID':jid,'AMAX_JOB_ID':jid}.items():args+=['--setenv',key,value]
    # CUDA re-enumerates the mounted device subset. A host UUID visibility filter
    # can mask that subset on some drivers; device mounts, not env vars, enforce it.
    args+=['--unsetenv','CUDA_VISIBLE_DEVICES']
    # Do not forward to the host's loopback-only resolved stub: host loopback is
    # intentionally inaccessible to jobs. Use the current real uplink resolvers.
    resolvers=[]
    for path in ['/run/systemd/resolve/resolv.conf','/etc/resolv.conf']:
        if Path(path).exists():
            for line in Path(path).read_text().splitlines():
                fields=line.split()
                if len(fields)>=2 and fields[0]=='nameserver' and not fields[1].startswith(('127.','::1')) and fields[1] not in resolvers:resolvers.append(fields[1])
        if resolvers:break
    if not resolvers:raise RuntimeError('No non-loopback uplink DNS configured')
    resolv=os.memfd_create('resolv');os.write(resolv,(''.join('nameserver '+ip+'\n' for ip in resolvers[:3])).encode());os.lseek(resolv,0,0)
    passwd=os.memfd_create('passwd');os.write(passwd,f'{spec["username"]}:x:{os.getuid()}:{os.getgid()}:GPUQ user:/workspace:/bin/bash\n'.encode());os.lseek(passwd,0,0)
    hosts=os.memfd_create('hosts');os.write(hosts,b'127.0.0.1 localhost gpuq-job\n::1 localhost\n');os.lseek(hosts,0,0)
    # EOF on bwrap's block-fd also unblocks it. The independent readiness gate makes
    # a failed network setup fail closed rather than briefly starting the job.
    gatefile=tempfile.NamedTemporaryFile(prefix='.gate-',dir=root);gatefile.write(b'0');gatefile.flush();ready=gatefile.fileno()
    gate='import os,sys; ready=open("/run/.ready","rb").read(1); sys.exit(125) if ready!=b"1" else os.execvpe(sys.argv[1],sys.argv[1:],os.environ)'
    args+=['--ro-bind',gatefile.name,'/run/.ready','--ro-bind-data',str(hosts),'/etc/hosts','--ro-bind-data',str(passwd),'/etc/passwd','--ro-bind-data',str(resolv),'/etc/resolv.conf','--','/usr/bin/python3','-c',gate,*spec['argv']]
    process=subprocess.Popen(args,pass_fds=(info_w,block_r,workfd,resolv,passwd,hosts));os.close(info_w);os.close(block_r);os.close(workfd);os.close(resolv);os.close(passwd);os.close(hosts)
    network=None
    try:
        if not select.select([info_r],[],[],12)[0]:raise RuntimeError('Sandbox startup timed out')
        information=json.loads(os.read(info_r,4096));os.close(info_r)
        ready_r,ready_w=os.pipe()
        network=subprocess.Popen([cfg.get('slirp','/usr/bin/slirp4netns'),'--configure','--disable-host-loopback','--enable-seccomp','--ready-fd',str(ready_w),str(information['child-pid']),'tap0'],pass_fds=(ready_w,),env={**env,'LD_LIBRARY_PATH':str(HERE/'netlib')},stdout=subprocess.DEVNULL)
        os.close(ready_w)
        if not select.select([ready_r],[],[],12)[0] or os.read(ready_r,1)!=b'1':raise RuntimeError('Sandbox networking unavailable')
        os.close(ready_r);os.pwrite(ready,b'1',0);os.write(block_w,b'1');os.close(block_w)
        return process.wait()
    finally:
        gatefile.close()
        if process.poll() is None:process.kill();process.wait()
        if network and network.poll() is None:network.terminate();network.wait(timeout=5)

if __name__=='__main__':
    try:sys.exit(main())
    except Exception as e:print('GPUQ sandbox:',str(e),file=sys.stderr);sys.exit(125)
