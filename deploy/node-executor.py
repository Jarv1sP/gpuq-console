#!/usr/bin/python3
"""Forced command. Fixed GPUQ wrapper; user commands only run inside the sandbox."""
import base64, fcntl, hashlib, json, os, re, sqlite3, stat, subprocess, sys, socket, time, uuid
from pathlib import Path
HERE=Path(__file__).resolve().parent
CONFIG=json.loads((HERE/'node-config.json').read_text())
ROOT=Path(CONFIG['root'])
RUNTIME=f'/run/user/{os.getuid()}'
ENV={'PATH':'/usr/bin:/bin','HOME':str(Path.home()),'LANG':'C.UTF-8','XDG_RUNTIME_DIR':RUNTIME,'DBUS_SESSION_BUS_ADDRESS':'unix:path='+RUNTIME+'/bus'}
UUID=re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')

def run(argv,timeout=18):
    p=subprocess.run(argv,env=ENV,text=True,capture_output=True,timeout=timeout)
    if p.returncode:raise ValueError((p.stderr or p.stdout or 'GPUQ failed')[-400:])
    if len(p.stdout)>2000000:raise ValueError('GPUQ response too large')
    return p.stdout

def gpu(*args):return json.loads(run([CONFIG['gpu'],'--json',*args]))

def gpuq_owner(job):
    # GPUQ labels are ASCII, but portal identity and ownership use immutable IDs.
    return job['username'] if re.fullmatch(r'[a-z][a-z0-9_-]{1,23}',job['username']) else 'portal-'+hashlib.sha256(job['userId'].encode()).hexdigest()[:24]

def workspace(user):
    if not isinstance(user,str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)',user):raise ValueError('Invalid identity')
    path=ROOT/'users'/hashlib.sha256(user.encode()).hexdigest()[:32]
    path.mkdir(parents=True,exist_ok=True,mode=0o700)
    return path

def file_op(operation,args):
    root=workspace(args['userId'])
    path=args.get('path','.')
    if not isinstance(path,str) or len(path)>1024 or '\0' in path or path.startswith('/') or '\\' in path:raise ValueError('Invalid relative path')
    parts=path.split('/') if path!='.' else []
    if any(p in ('','.','..') or len(p)>255 for p in parts):raise ValueError('Invalid relative path')
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
    fd=os.open(root,flags)
    try:
        directories=parts if operation=='files.list' else parts[:-1]
        for part in directories:
            if operation=='files.put':
                try:os.mkdir(part,mode=0o700,dir_fd=fd)
                except FileExistsError:pass
            nxt=os.open(part,flags,dir_fd=fd);os.close(fd);fd=nxt
        if operation=='files.list':
            out=[]
            for name in sorted(os.listdir(fd))[:1000]:
                st=os.stat(name,dir_fd=fd,follow_symlinks=False)
                out.append({'name':name,'size':st.st_size,'type':'directory' if stat.S_ISDIR(st.st_mode) else 'file' if stat.S_ISREG(st.st_mode) else 'unsupported'})
            return {'entries':out}
        if not parts:raise ValueError('File path required')
        offset=args.get('offset',0)
        if type(offset)!=int or not 0<=offset<=100*1024**3:raise ValueError('Invalid offset')
        f=os.open(parts[-1],(os.O_RDWR|os.O_CREAT if operation=='files.put' else os.O_RDONLY)|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=fd)
        try:
            st=os.fstat(f)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1:raise ValueError('Only unlinked regular files allowed')
            fcntl.flock(f,(fcntl.LOCK_EX if operation=='files.put' else fcntl.LOCK_SH)|fcntl.LOCK_NB)
            if operation=='files.put':
                data=base64.b64decode(args.get('data',''),validate=True)
                if len(data)>1024*1024:raise ValueError('Chunk too large')
                space=os.statvfs(root)
                if space.f_bavail*space.f_frsize<10*1024**3+len(data):raise ValueError('Workspace disk reserve reached')
                if args.get('truncate') is True:
                    if offset!=0:raise ValueError('Invalid truncate offset')
                    os.ftruncate(f,0);st=os.fstat(f)
                if offset!=st.st_size:raise ValueError('Upload offset mismatch; restart this file')
                if st.st_size+len(data)>100*1024**3:raise ValueError('File too large')
                os.lseek(f,offset,0)
                view=memoryview(data)
                while view:view=view[os.write(f,view):]
                os.fsync(f)
                return {'path':path,'size':os.fstat(f).st_size}
            os.lseek(f,offset,0);data=os.read(f,1024*1024)
            return {'path':path,'size':st.st_size,'offset':offset,'data':base64.b64encode(data).decode(),'eof':offset+len(data)>=st.st_size}
        finally:os.close(f)
    finally:os.close(fd)

def validate_job(job):
    if not isinstance(job,dict) or set(job)!={'id','userId','username','cards','argv','name','minVramGiB'}:raise ValueError('Invalid job specification')
    if not UUID.fullmatch(job['id']):raise ValueError('Invalid job ID')
    workspace(job['userId'])
    if not re.fullmatch(r'[a-z\u3400-\u9fff][a-z0-9_\u3400-\u9fff-]{1,23}',job['username']):raise ValueError('Invalid username')
    if type(job['cards'])!=int or not 1<=job['cards']<=CONFIG.get('cards',64):raise ValueError('Invalid card count')
    if not isinstance(job['argv'],list) or not 1<=len(job['argv'])<=128 or any(not isinstance(a,str) or '\0' in a for a in job['argv']) or len(json.dumps(job['argv']))>12000:raise ValueError('Invalid argv')

def terminal_alive(folder,jid):
    if not isinstance(jid,str) or not UUID.fullmatch(jid):return False
    try:
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(2);client.connect(str(folder/(jid+'.sock')));client.sendall(b'{"offset":2147483647}\n');raw=b''
            while b'\n' not in raw:
                part=client.recv(65536)
                if not part or len(raw)>1000000:return False
                raw+=part
            result=json.loads(raw)
            return not result.get('error') and result.get('exited') is False
    except (OSError,ValueError):return False

def stop_terminal(jid):
    # Stable unit protocol shared with existing terminal pointers; not branding.
    unit='amax-term-'+jid+'.service'
    result=subprocess.run(['/usr/bin/systemctl','--user','stop',unit],env=ENV,text=True,capture_output=True,timeout=12)
    if result.returncode:
        active=subprocess.run(['/usr/bin/systemctl','--user','is-active','--quiet',unit],env=ENV,timeout=5)
        if active.returncode==0:raise ValueError('Terminal could not be stopped')

def terminal_op(operation,args):
    if args.get('hostAdmin') is True and not CONFIG.get('hostRoot',False):raise ValueError('Host root terminal is disabled on this node')
    workspace(args['userId'])
    if not re.fullmatch(r'[a-z\u3400-\u9fff][a-z0-9_\u3400-\u9fff-]{1,23}',args['username']):raise ValueError('Invalid username')
    folder=ROOT/'terminals';folder.mkdir(mode=0o700,exist_ok=True)
    identity=hashlib.sha256((args['userId']+('host' if args.get('hostAdmin') is True else 'private')).encode()).hexdigest()[:20]
    pointer=folder/(identity+'.current')
    with open(folder/(identity+'.lock'),'a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        jid=pointer.read_text() if pointer.exists() else None
        if operation=='terminal.open':
            if not terminal_alive(folder,jid):
                if jid and UUID.fullmatch(jid):
                    stop_terminal(jid);(folder/(jid+'.sock')).unlink(missing_ok=True)
                jid=args['key']
                if not isinstance(jid,str) or not UUID.fullmatch(jid):raise ValueError('Invalid terminal ID')
                if (folder/(jid+'.json')).exists():jid=str(uuid.uuid4())
                unit='amax-term-'+jid
                spec={'userId':args['userId'],'username':args['username'],'cards':0,'argv':['/bin/bash','--noprofile','--norc','-i'],'hostAdmin':args.get('hostAdmin') is True}
                with open(folder/(jid+'.json'),'x') as f:json.dump(spec,f)
                pointer.write_text(jid)
                command=['/usr/bin/systemd-run','--user','--collect','--unit',unit,'--property=RuntimeMaxSec=21600','--property=KillMode=control-group','--property=TimeoutStopSec=5']
                if not spec['hostAdmin']:command+=['--property=MemoryMax=8G','--property=CPUQuota=200%','--property=TasksMax=2048']
                run(command+['/usr/bin/python3',str(HERE/'terminal-helper.py'),jid])
                for _ in range(30):
                    if (folder/(jid+'.sock')).exists():break
                    time.sleep(0.1)
            return {'id':jid,'hostAdmin':args.get('hostAdmin') is True}
        if not jid or jid!=args.get('id'):raise ValueError('Terminal not found or not owned')
        if operation=='terminal.close':
            stop_terminal(jid)
            (folder/(jid+'.sock')).unlink(missing_ok=True);pointer.unlink(missing_ok=True)
            return {'closed':True}
        request={key:args[key] for key in ('input','offset','rows','cols') if key in args}
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(4);client.connect(str(folder/(jid+'.sock')));client.sendall((json.dumps(request)+'\n').encode());raw=b''
            while b'\n' not in raw:
                part=client.recv(65536)
                if not part:break
                raw+=part
                if len(raw)>1000000:raise ValueError('Terminal response too large')
            result=json.loads(raw)
            if result.get('error'):raise ValueError(result['error'])
            return result

def process(operation,args):
    if operation in ('terminal.open','terminal.exchange','terminal.close'):return terminal_op(operation,args)
    if operation.startswith('files.') and operation in ('files.list','files.put','files.get'):return file_op(operation,args)
    if operation not in ('sync','cancel','logs'):raise ValueError('Unknown operation')
    job=args['job'];validate_job(job);jid=job['id']
    (ROOT/'jobs').mkdir(parents=True,exist_ok=True,mode=0o700)
    with open(ROOT/'jobs'/f'{jid}.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        spec=ROOT/'jobs'/f'{jid}.json'
        if spec.exists():
            if json.loads(spec.read_text())!=job:raise ValueError('Job identity mismatch')
        else:
            with open(spec,'x') as f:json.dump(job,f);f.flush();os.fsync(f.fileno())
        # GPUQ is the source of truth for dispatch idempotency, including SSH failures.
        with sqlite3.connect(f'file:{CONFIG["database"]}?mode=ro',uri=True) as db:
            row=db.execute('SELECT id FROM jobs WHERE submit_key=?',(jid,)).fetchone()
        canceled=ROOT/'jobs'/f'{jid}.canceled'
        if not row:
            if operation=='cancel' or canceled.exists():
                canceled.touch(mode=0o600,exist_ok=True)
                return {'state':'CANCELED'}
            if operation=='logs':return {'text':'任务尚未提交到 GPUQ。'}
            result=gpu('submit','-g',str(job['cards']),'-p','P0','-m','queue','--yield','never','--restart-policy','never','-n','portal-'+jid[:8],'-u',gpuq_owner(job),'--cwd',str(workspace(job['userId'])),'--submit-key',jid,'--','/usr/bin/python3',str(HERE/'sandbox-runner.py'),jid)
            node_id=result['job_id']
        else:node_id=row[0]
        data=gpu('show',node_id);state=data.get('job',data)
        if operation=='logs':
            if not data.get('attempts'):return {'text':'任务正在排队，尚未产生运行日志。'}
            return {'text':run([CONFIG['gpu'],'logs','-n','200',node_id])[-200000:]}
        if operation=='cancel' and state['state'] not in ('SUCCEEDED','FAILED','CANCELED'):
            gpu('cancel',node_id);data=gpu('show',node_id);state=data.get('job',data)
        attempts=data.get('attempts',[])
        assigned=attempts[-1].get('gpu_indices',[]) if attempts and state['state'] not in ('SUCCEEDED','FAILED','CANCELED','LOST') else []
        return {'nodeJobId':node_id,'state':state['state'],'assignedIndices':assigned}

if __name__=='__main__':
    os.umask(0o077)
    try:
        raw=sys.stdin.buffer.read(1600001)
        if len(raw)>1600000:raise ValueError('Request too large')
        data=json.loads(raw)
        result=process(data['operation'],data['args'])
        print(json.dumps({'ok':True,'result':result}))
    except Exception as e:print(json.dumps({'ok':False,'error':str(e)[:400]}))
