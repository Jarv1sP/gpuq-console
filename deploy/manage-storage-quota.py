#!/usr/bin/python3
"""Offline quota lifecycle: read-only plan by default, exact approved CAS to write.

Never remount, format, start services, change owners/modes, delete data or enable
features. Keep the maintenance fence and stop all service/subuid payloads first.
Partial attempts retain their intent and original policy; they cannot replay.
"""
import argparse
import contextlib
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import stat
import sys
import time

sys.dont_write_bytecode = True  # Default read-only plans must not mutate a code tree.
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('gpuq_quota_lifecycle', HERE/'configure-storage-quota.py')
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
q = c.q
CONTROL = Path('/etc/gpuq-console/quota-admin')
LOCK = Path('/run/lock/gpuq-storage-quota-admin.lock')
FENCE = Path('/etc/gpuq-console-maintenance')
MAX_ENTRIES = 500000
IDLE_EXECUTABLES = {'/usr/lib/systemd/systemd', '/lib/systemd/systemd',
                    '/usr/bin/dbus-daemon', '/usr/bin/dbus-broker', '/usr/bin/dbus-broker-launch'}


def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
def sha(raw): return hashlib.sha256(raw).hexdigest()


def identity(info):
    return [info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def protected_bytes(path, maximum=1024**2):
    """Exact root-owned no-follow bytes and inode/metadata CAS, not JSON reencode."""
    path = Path(path)
    with q.directory(path.parent) as parent:
        p = os.fstat(parent)
        q.need(p.st_uid == 0 and not p.st_mode & 0o022, 'Control parent is not root protected')
        fd = os.open(path.name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=parent)
        try:
            before = os.fstat(fd)
            q.need(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and not before.st_mode & 0o022
                   and before.st_nlink == 1 and before.st_size <= maximum, 'Unsafe administrator control file')
            raw = os.read(fd, maximum+1)
            q.need(len(raw) == before.st_size and identity(os.fstat(fd)) == identity(before)
                   and identity(os.stat(path.name, dir_fd=parent, follow_symlinks=False)) == identity(before),
                   'Administrator control file changed')
            return raw, {'path': str(path), 'sha256': sha(raw), 'identity': identity(before),
                         'parentIdentity': [p.st_dev,p.st_ino,p.st_mode,p.st_uid,p.st_gid]}
        finally: os.close(fd)


def policy_state():
    raw, meta = protected_bytes(q.POLICY)
    return q.validate_policy(json.loads(raw)), raw, meta


def offline_gate(policy):
    """No service-account/rootless payloads; only fixed root-owned idle managers.

    This is an offline administration gate, not a claim to constrain trusted
    host root/SSH. We read UID/exe metadata only, never process argv/environment.
    """
    q.need(os.geteuid() == 0, 'Quota lifecycle requires host administrator')
    _, fence = protected_bytes(FENCE, 16384)
    uid = policy['serviceUid']; account = pwd.getpwuid(uid).pw_name
    ranges = []; subordinate = {}
    for path in (Path('/etc/subuid'), Path('/etc/subgid')):
        raw, meta = protected_bytes(path); subordinate[str(path)] = meta
        for line in raw.decode().splitlines():
            fields = line.split(':')
            if len(fields) == 3 and fields[0] in (account, str(uid)):
                q.need(fields[1].isdigit() and fields[2].isdigit() and int(fields[2]) > 0,
                       'Invalid subordinate identity range')
                ranges.append((int(fields[1]), int(fields[1])+int(fields[2])))
    idle = []
    for path in sorted(Path('/proc').iterdir()):
        if not path.name.isdigit(): continue
        try:
            fields = dict(line.split(':', 1) for line in (path/'status').read_text().splitlines() if ':' in line)
            ids = [int(item) for item in fields['Uid'].split()]
            if not any(v == uid or any(a <= v < b for a,b in ranges) for v in ids): continue
            before = (path/'stat').read_text().rsplit(')',1)[1].split()[19]
            exe = os.readlink(path/'exe')
            # The managers themselves have no data payload. Any child, including
            # UID-mapped OCI processes, is independently inspected and rejected.
            trusted = Path(exe).stat() if exe in IDLE_EXECUTABLES else None
            group_rows = (path/'cgroup').read_text().splitlines()
            groups = [line[3:] for line in group_rows if line.startswith('0::')]
            prefix = '/user.slice/user-'+str(uid)+'.slice/user@'+str(uid)+'.service/'
            expected = {prefix+'init.scope'} if exe.endswith('/systemd') else {
                prefix+'session.slice/dbus.service', prefix+'app.slice/dbus.service',
                prefix+'session.slice/dbus-broker.service', prefix+'app.slice/dbus-broker.service'}
            q.need(ids == [uid]*4 and trusted is not None and trusted.st_uid == 0
                   and stat.S_ISREG(trusted.st_mode) and not trusted.st_mode & 0o022
                   and len(groups)==1 and groups[0] in expected,
                   'Live service/rootless process blocks offline quota administration')
            q.need((path/'stat').read_text().rsplit(')',1)[1].split()[19] == before,
                   'Process identity changed during offline check')
            idle.append({'pid': int(path.name), 'startTime': before, 'exe': exe})
        except FileNotFoundError:
            continue  # An exited PID cannot still write; fresh gate is repeated.
    observed = q.check_guard(policy)
    q.need(isinstance(observed,dict) and observed.get('guarded') is True,
           'Quota lifecycle requires enabled physical root guard')
    _, guard_pin = protected_bytes(Path('/etc/gpuq-platform-root/pin.json'),16384)
    return {'fence': fence, 'idleProcesses': idle, 'rootGuard': observed, 'rootGuardPin': guard_pin,
            'subordinateIdentity': subordinate, 'subordinateRanges': sorted(set(ranges))}


def source_pins():
    return {name: sha((HERE/name).read_bytes()) for name in
            ('manage-storage-quota.py','configure-storage-quota.py','storage-quota.py','platform-root-guard.py')}


def current_limit(policy, key, project_id):
    volume, device = q.volume_for(policy, policy['volumes'][key]['mountPoint'])
    q.need(volume == key, 'Quota volume identity changed')
    actual = q.quotactl(device, project_id)
    q.need(set(actual) == {'bytes','inodes','usedBytes','usedInodes'}
           and all(type(v) is int and v >= 0 for v in actual.values()), 'Invalid kernel quota counters')
    return str(device), actual


def policy_plan(candidate):
    old, _, meta = policy_state(); candidate = q.validate_policy(copy.deepcopy(candidate))
    gate = offline_gate(old)
    q.need({k:v for k,v in old.items() if k != 'owners'} ==
           {k:v for k,v in candidate.items() if k != 'owners'}, 'Policy roots/volumes/identity cannot change')
    q.need(set(old['owners']) <= set(candidate['owners']), 'Owner deletion/ID reuse is not supported')
    changes = []
    for owner, row in sorted(candidate['owners'].items()):
        previous = old['owners'].get(owner)
        if previous:
            q.need(row['projectId'] == previous['projectId'] and set(previous['limits']) <= set(row['limits']),
                   'Owner project ID/volume removal is not supported')
        else:
            # Never adopt a project ID with hidden data on another configured
            # filesystem. Owner deletion is forbidden, so IDs cannot be reused.
            for key in old['volumes']:
                _, actual = current_limit(old, key, row['projectId'])
                q.need(actual == {'bytes':0,'inodes':0,'usedBytes':0,'usedInodes':0}, 'New owner project ID is already used')
        for key, after in sorted(row['limits'].items()):
            device, before = current_limit(old, key, row['projectId'])
            expected = previous['limits'].get(key) if previous else None
            if expected is not None:
                q.need(all(before[k] == expected[k] for k in ('bytes','inodes')), 'Existing kernel limits drifted from policy')
            else:
                q.need(before == {'bytes':0,'inodes':0,'usedBytes':0,'usedInodes':0}, 'New quota volume project ID is already used')
            q.need(after['bytes'] >= before['usedBytes'] and after['inodes'] >= before['usedInodes'],
                   'New quota limit is below current kernel usage')
            if expected != after:
                changes.append({'owner':owner,'volume':key,'projectId':row['projectId'],
                                'device':device,'before':before,'after':after})
    q.need(changes, 'Quota policy has no limit changes')
    return {'schema':1,'operation':'policy','policy':meta,'gate':gate,'sourceSHA256':source_pins(),
            'candidate':candidate,'changes':changes,'mountsChanged':False,'featuresEnabled':False}


def nested_mounts(path):
    """A same-device bind under a tree must not hide or alias migration entries."""
    import re
    found = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left = line.split(' - ',1)[0].split()
        q.need(len(left) >= 6, 'Malformed mount table')
        mount = Path(re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),left[4]))
        if path in mount.parents: found.append(str(mount))
    q.need(not found, 'Nested mount blocks owner-tree migration')


def tree_snapshot(path, uid, project_id):
    """No-follow bounded descriptor walk; preserve bytes and internal hardlinks.

    The metadata stream (stat identity/ctime, quota project-ID/inheritance flags
    and relative names) is hashed for approval. Other xattrs are not read.
    External hardlinks, symlinks and unknown IDs fail.
    No file contents are read or rewritten.
    """
    path = Path(path); nested_mounts(path)
    records, links, unique = [], {}, set()
    unassigned_bytes = unassigned_inodes = 0
    def visit(fd, relative, root_dev):
        nonlocal unassigned_bytes, unassigned_inodes
        before = os.fstat(fd); attr = q.attribute(fd)
        q.need(before.st_dev == root_dev and before.st_uid == uid and not before.st_mode & 0o022
               and (stat.S_ISDIR(before.st_mode) or stat.S_ISREG(before.st_mode)), 'Unsafe owner-tree entry')
        q.need(attr[0] in (0, project_id), 'Owner-tree entry has another project ID')
        key = (before.st_dev,before.st_ino)
        row = {'path':relative,'identity':identity(before),'projectId':attr[0],'inherit':attr[1],
               'blocks':before.st_blocks,'directory':stat.S_ISDIR(before.st_mode)}
        records.append(row)
        q.need(len(records) <= MAX_ENTRIES, 'Owner tree exceeds migration entry limit')
        if key not in unique:
            unique.add(key)
            if attr[0] == 0:
                unassigned_bytes += before.st_blocks*512; unassigned_inodes += 1
        if row['directory']:
            for name in sorted(os.listdir(fd)):
                child = os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
                try: visit(child,name if relative=='.' else relative+'/'+name,root_dev)
                finally: os.close(child)
        else:
            entry = links.setdefault(key,{'count':0,'nlink':before.st_nlink})
            q.need(entry['nlink'] == before.st_nlink, 'Hardlink identity changed')
            entry['count'] += 1
        q.need(identity(os.fstat(fd)) == identity(before) and q.attribute(fd) == attr,
               'Owner tree changed during scan')
    with q.directory(path) as fd:
        info = os.fstat(fd)
        q.need(info.st_uid == uid and not info.st_mode & 0o077, 'Owner root must be service-private')
        visit(fd,'.',info.st_dev)
    q.need(all(item['count'] == item['nlink'] for item in links.values()), 'External hardlink blocks owner-tree migration')
    return records, {'sha256':sha(canonical(records)),'entries':len(records),'uniqueInodes':len(unique),
                     'unassignedBytes':unassigned_bytes,'unassignedInodes':unassigned_inodes,
                     'internalHardlinkGroups':sum(item['count']>1 for item in links.values())}


def migration_plan(user, path, project=None):
    policy, _, meta = policy_state(); gate = offline_gate(policy)
    row = q.quota_owner(policy,user); path = Path(path)
    kind = q.allowed_path(policy,user,path)
    q.need(kind in ('owner-root','dataset-stage','project-upload'), 'This quota tree requires separate migration review')
    if kind == 'project-upload':
        q.need(isinstance(project,str) and q.SLUG.fullmatch(project), 'Upload migration requires project slug')
        key = hashlib.sha256(json.dumps([user,project]).encode()).hexdigest()
        q.need(path.name == key+'.uploads','Upload migration owner mismatch')
    else: q.need(project is None,'Unexpected migration project slug')
    volume, device = q.volume_for(policy,path); q.need(volume in row['limits'],'Owner has no quota on this volume')
    actual = q.quotactl(device,row['projectId']); expected = row['limits'][volume]
    q.need(set(actual)=={'bytes','inodes','usedBytes','usedInodes'}
           and all(type(v) is int and v >= 0 for v in actual.values())
           and all(actual[k] == expected[k] for k in ('bytes','inodes')), 'Kernel quota limits drifted')
    _, tree = tree_snapshot(path,policy['serviceUid'],row['projectId'])
    q.need(actual['usedBytes']+tree['unassignedBytes'] <= expected['bytes'] and
           actual['usedInodes']+tree['unassignedInodes'] <= expected['inodes'], 'Migration exceeds finite owner quota')
    return {'schema':1,'operation':'migrate','policy':meta,'gate':gate,'sourceSHA256':source_pins(),
            'owner':user,'path':str(path),'project':project,'kind':kind,'volume':volume,'device':str(device),
            'projectId':row['projectId'],'kernelBefore':actual,'tree':tree,
            'fileContentsChanged':False,'ownershipChanged':False,'mountsChanged':False,'featuresEnabled':False}


@contextlib.contextmanager
def administration_lock():
    with q.directory(LOCK.parent) as parent:
        fd = os.open(LOCK.name,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=parent)
        try:
            info = os.fstat(fd)
            q.need(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1 and not info.st_mode & 0o077,
                   'Unsafe quota administration lock')
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            yield
        finally: os.close(fd)


def publish_policy(raw, expected):
    """Same-root-owned-policy atomic replacement; retained backup precedes write."""
    _, actual = protected_bytes(q.POLICY)
    q.need(actual == expected, 'Root quota policy changed before publication')
    with q.directory(q.POLICY.parent) as parent:
        name = '.quota-'+sha(raw)+'.candidate'
        c.put_new(q.POLICY.parent/name,raw,stat.S_IMODE(expected['identity'][2]))
        _, actual = protected_bytes(q.POLICY)
        q.need(actual == expected,'Root quota policy CAS changed')
        os.replace(name,q.POLICY.name,src_dir_fd=parent,dst_dir_fd=parent); os.fsync(parent)


def migrate_entries(plan, records, *, evidence):
    done = set(); project = plan['projectId']
    # Files before directories; set parent inheritance only after children have
    # been charged. Every mutation is preceded by exact per-inode/xattr CAS.
    order = sorted(records,key=lambda r:(r['directory'],-(0 if r['path']=='.' else r['path'].count('/')+1)))
    for row in order:
        key = tuple(row['identity'][:2])
        if key in done: continue
        path = Path(plan['path']) if row['path']=='.' else Path(plan['path'])/row['path']
        with q.directory(path if row['directory'] else path.parent) as parent:
            fd = os.dup(parent) if row['directory'] else os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
            try:
                q.need(identity(os.fstat(fd)) == row['identity'] and
                       q.attribute(fd) == (row['projectId'],row['inherit']), 'Tree entry changed before quota assignment')
                if row['projectId'] != project or (row['directory'] and not row['inherit']):
                    q.attribute(fd,project,inherit=row['directory'] or row['inherit'])
                q.need(q.attribute(fd) == (project,True if row['directory'] else row['inherit']), 'Quota assignment readback mismatch')
                after=identity(os.fstat(fd))
                q.need(after[:-1]==row['identity'][:-1],'Tree entry metadata changed during quota assignment')
                os.fsync(fd); evidence[key]=after; done.add(key)
            finally: os.close(fd)
    return len(done)


def verify_tree(before, after, project, evidence):
    q.need(len(before)==len(after),'Owner tree changed after migration')
    for old,new in zip(before,after):
        # FSSETXATTR changes ctime. Nothing else may change, including file
        # bytes/mtime, ownership/modes, inode identity, names and hardlinks.
        left,right=copy.deepcopy(old),copy.deepcopy(new)
        q.need(new['identity']==evidence[tuple(old['identity'][:2])],
               'Tree entry changed after quota assignment')
        q.need(new['projectId']==project and new['inherit']==(True if old['directory'] else old['inherit']),
               'Owner tree quota readback mismatch')
        for row in (left,right):
            row['identity']=row['identity'][:-1]; row.pop('projectId'); row.pop('inherit')
        q.need(left==right,'Owner tree structural/content metadata changed')


def execute(plan, approved_sha):
    q.need(os.geteuid()==0,'Quota lifecycle requires explicit administrator execution')
    q.need(isinstance(plan,dict) and plan.get('schema')==1 and plan.get('operation') in ('policy','migrate')
           and sha(canonical(plan))==approved_sha,'Approved quota plan changed')
    with administration_lock():
        fresh = policy_plan(plan['candidate']) if plan['operation']=='policy' else migration_plan(plan['owner'],plan['path'],plan.get('project'))
        q.need(fresh==plan,'Quota plan CAS changed; prepare a new plan without replaying old intent')
        policy, raw, _ = policy_state()
        c.protected_directory(CONTROL.parent); c.protected_directory(CONTROL)
        run=CONTROL/approved_sha
        run.mkdir(mode=0o700)  # O_EXCL namespace: failed/pending intent never replayed.
        with q.directory(CONTROL) as fd: os.fsync(fd)
        c.put_new(run/'intent.json',canonical(plan),0o600)
        c.put_new(run/'policy-before.json',raw,0o600)
        receipt={'schema':1,'planSHA256':approved_sha,'operation':plan['operation'],'phase':'REVIEW_REQUIRED',
                 'featuresEnabled':False,'mountsChanged':False,'attemptStartedAt':time.time()}
        try:
            q.need(offline_gate(policy)==plan['gate'],'Offline writer gate changed before mutation')
            if plan['operation']=='policy':
                for item in plan['changes']:
                    device,before=current_limit(policy,item['volume'],item['projectId'])
                    q.need(device==item['device'] and before==item['before'],'Kernel quota CAS changed')
                    q.quotactl(device,item['projectId'],item['after'])
                    actual=q.quotactl(device,item['projectId'])
                    q.need(all(actual[k]==item['after'][k] for k in ('bytes','inodes')),'Kernel limit readback mismatch')
                q.need(offline_gate(policy)==plan['gate'],'Offline writer gate changed before policy publish')
                publish_policy(canonical(plan['candidate']),plan['policy'])
                receipt.update(phase='POLICY_UPDATED',policySHA256=sha(canonical(plan['candidate'])))
            else:
                records,tree=tree_snapshot(plan['path'],policy['serviceUid'],plan['projectId'])
                q.need(tree==plan['tree'],'Owner tree changed before migration')
                evidence={}; count=migrate_entries(plan,records,evidence=evidence)
                after,summary=tree_snapshot(plan['path'],policy['serviceUid'],plan['projectId'])
                verify_tree(records,after,plan['projectId'],evidence)
                q.need(offline_gate(policy)==plan['gate'],'Offline writer gate changed during migration')
                _,meta=protected_bytes(q.POLICY); q.need(meta==plan['policy'],'Policy changed during migration')
                volume,device=q.volume_for(policy,plan['path'])
                q.need(volume==plan['volume'] and str(device)==plan['device'],'Migration backing volume changed')
                limits=q.quotactl(plan['device'],plan['projectId']); expected=policy['owners'][plan['owner']]['limits'][plan['volume']]
                q.need(all(limits[k]==expected[k] for k in ('bytes','inodes')) and limits['usedBytes']<=expected['bytes']
                       and limits['usedInodes']<=expected['inodes'],'Migrated kernel quota exceeds/drifts from policy')
                receipt.update(phase='TREE_MIGRATED',uniqueInodes=count,treeAfter=summary,kernelAfter=limits)
            c.put_new(run/'receipt.json',canonical(receipt),0o600)
            return receipt
        except BaseException:
            receipt['error']='QUOTA_ADMIN_INTERRUPTED_REVIEW_REQUIRED'
            c.put_new(run/'receipt.json',canonical(receipt),0o600)
            raise  # Keep fence/partial ownership/limits/backup, never auto-rollback.


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=('policy','migrate','status'))
    parser.add_argument('--candidate'); parser.add_argument('--owner'); parser.add_argument('--path'); parser.add_argument('--project')
    parser.add_argument('--execute',action='store_true'); parser.add_argument('--plan'); parser.add_argument('--approved-plan-sha256')
    args=parser.parse_args(argv)
    if args.execute:
        q.need(args.operation!='status' and args.plan and args.approved_plan_sha256
               and not any((args.candidate,args.owner,args.path,args.project)),'Execute accepts only an approved saved plan')
        saved=json.loads(protected_bytes(Path(args.plan),64*1024**2)[0])
        q.need(isinstance(saved,dict) and set(saved)=={'plan','planSHA256'}
               and saved['planSHA256']==args.approved_plan_sha256,'Saved quota plan approval mismatch')
        plan=saved['plan']
        q.need(isinstance(plan,dict) and plan.get('operation')==args.operation,'Plan operation mismatch')
        result=execute(plan,args.approved_plan_sha256)
    else:
        q.need(not args.plan and not args.approved_plan_sha256,'Read-only mode does not accept execution approval')
        if args.operation=='policy':
            q.need(args.candidate and not any((args.owner,args.path,args.project)),'Policy plan needs only candidate policy')
            result=policy_plan(json.loads(protected_bytes(Path(args.candidate))[0]))
        elif args.operation=='migrate':
            q.need(args.owner and args.path and not args.candidate,'Migration plan needs owner/path')
            result=migration_plan(args.owner,args.path,args.project)
        else:
            q.need(args.owner and not any((args.candidate,args.path,args.project)),'Status needs only owner')
            q.need(os.geteuid()==0,'Offline quota status requires administrator')
            result=q.kernel_status(policy_state()[0],args.owner)
    if not args.execute and args.operation!='status':
        result={'plan':result,'planSHA256':sha(canonical(result))}
    print(json.dumps(result,sort_keys=True))


if __name__=='__main__': main()
