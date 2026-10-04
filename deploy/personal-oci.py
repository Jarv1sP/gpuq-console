#!/usr/bin/python3
"""Managed rootless OCI projects. No socket or arbitrary Podman flags in RPC.

Containers are root only inside a user namespace. Every owner has a private,
quota-checked graphroot. A stopped development container is committed BEFORE
replacement, so package installs survive terminal reconnects without a daemon
escaping the terminal's systemd cgroup. Training always uses an immutable image
ID and the scheduler's exact CDI GPU UUIDs; development has no devices.
"""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time
import uuid

HERE = Path(__file__).resolve().parent
IMAGE = re.compile(r'sha256:[a-f0-9]{64}\Z')
BASE = re.compile(r'[a-z0-9][a-z0-9.:-]*/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}\Z')
GPU = re.compile(r'GPU-[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\Z')
HOOKS = Path('/etc/gpuq-console/empty-hooks')
CDI = Path('/etc/cdi/gpuq-nvidia.json')
ENGINE = Path('/etc/gpuq-console/personal-oci.conf')
ENGINE_RAW = b'[containers]\nenv_host = false\nhttp_proxy = false\nvolumes = []\ndevices = []\n[engine]\nremote = false\n'


def module(name):
    paths = {'storage-quota':'storage-quota.py','project-store':'project-store.py',
             'training-control':'training-control.py','job-resources':'job-resources.py'}
    spec = importlib.util.spec_from_file_location('gpuq_oci_'+name.replace('-', '_'), HERE/paths[name])
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def need(condition, message):
    if not condition:
        raise ValueError(message)


def policy(config):
    value = config.get('personalOci', {'enabled': False})
    need(isinstance(value, dict) and type(value.get('enabled')) is bool, 'Invalid personal OCI policy')
    if value['enabled'] is False:
        need(set(value) == {'enabled'}, 'Disabled OCI policy must be explicit')
        raise ValueError('Personal OCI is not enabled on this node; use shared/isolated venv mode')
    need(set(value) == {'enabled', 'baseImage', 'podmanSHA256', 'runtimeSHA256', 'cdiSHA256'}
         and isinstance(value['baseImage'], str) and BASE.fullmatch(value['baseImage'])
         and all(isinstance(value[k], str) and re.fullmatch('[a-f0-9]{64}', value[k])
                 for k in ('podmanSHA256', 'runtimeSHA256', 'cdiSHA256')), 'Invalid trusted OCI capability policy')
    need(module('storage-quota').enabled(config), 'OCI requires verified kernel hard quotas')
    return value


def protected_file(path, expected, *, executable=False):
    path = Path(path)
    st = path.lstat()
    need(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022
         and st.st_nlink == 1 and (not executable or st.st_mode & 0o111), 'Untrusted OCI host dependency')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        need(os.fstat(fd) == st, 'OCI dependency replaced')
        digest = hashlib.sha256()
        while chunk := os.read(fd, 1024**2):
            digest.update(chunk)
        need(digest.hexdigest() == expected, 'OCI host dependency differs from accepted version')
    finally:
        os.close(fd)


def cdi_devices(raw, uuids):
    """Strict UUID selection only; never accept `all`, indices or caller CDI."""
    need(isinstance(uuids, list) and 0 < len(uuids) <= 64 and len(set(uuids)) == len(uuids)
         and all(isinstance(v, str) and GPU.fullmatch(v) for v in uuids), 'Invalid scheduler GPU UUIDs')
    value = json.loads(raw)
    need(value.get('kind') == 'nvidia.com/gpu' and isinstance(value.get('devices'), list), 'Invalid administrator CDI specification')
    names = [device.get('name') for device in value['devices']]
    need(len(names) == len(set(names)) and all(v in names for v in uuids), 'Assigned GPU missing from pinned CDI specification')
    return ['nvidia.com/gpu='+gpu for gpu in uuids]


def translate_control(arguments):
    """Translate only the trusted training-control module's narrow bwrap DSL."""
    result, i = [], 0
    while i < len(arguments):
        op = arguments[i]
        if op == '--dir':
            i += 2
        elif op in ('--bind-fd', '--ro-bind-data'):
            fd, target = arguments[i+1:i+3]
            need(str(int(fd)) == fd and target in ('/run/gpuq/control', '/opt/gpuq/sdk.pyz', '/opt/gpuq/libvgpu.so'),
                 'Unexpected OCI scheduler mount')
            result += ['--volume', '/proc/'+str(os.getpid())+'/fd/'+fd+':'+target+(':'+'ro' if op == '--ro-bind-data' else ':rw')]
            i += 3
        elif op == '--setenv':
            key, value = arguments[i+1:i+3]
            need(re.fullmatch('[A-Z][A-Z0-9_]*', key) and '\x00' not in value, 'Invalid scheduler environment')
            result += ['--env', key+'='+value]
            i += 3
        else:
            raise ValueError('Unsupported OCI training-control mount operation')
    return result


class PersonalOCI:
    def __init__(self, config, user):
        self.config, self.user = config, user
        self.policy = policy(config)
        self.s = module('project-store')
        self.q = module('storage-quota')
        self.root = self.s.absolute(config['root'])
        self.s.check_platform_root(self.root)
        need(isinstance(user, str) and re.fullmatch(r'builtin-admin|demo-user-[0-9]+', user), 'Invalid OCI owner')
        self.owner = hashlib.sha256(user.encode()).hexdigest()
        parent = self.s.private_dir(self.root/'oci', create=True)
        self.folder = self.s.private_dir(parent/self.owner, create=True)
        self.q.ensure(config, user, self.folder)
        for name in ('graph', 'run', 'tmp', 'home', 'projects'):
            self.s.private_dir(self.folder/name, create=True)
        self.env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': str(self.folder/'home'),
                    'XDG_CONFIG_HOME': str(self.folder/'home'), 'XDG_DATA_HOME': str(self.folder/'home'),
                    'XDG_RUNTIME_DIR': '/run/user/'+str(os.getuid()), 'TMPDIR': str(self.folder/'tmp'),
                    'REGISTRY_AUTH_FILE': '/dev/null', 'LANG': 'C.UTF-8',
                    'CONTAINERS_CONF': str(ENGINE)}

    def command(self, *args):
        return ['/usr/bin/podman', '--root', str(self.folder/'graph'), '--runroot', str(self.folder/'run'),
                '--tmpdir', str(self.folder/'tmp'), '--storage-driver=overlay', '--cgroup-manager=cgroupfs',
                '--runtime=/usr/bin/crun', '--hooks-dir='+str(HOOKS), '--events-backend=file', *args]

    def run(self, *args, timeout=30):
        result = subprocess.run(self.command(*args), env=self.env, capture_output=True, text=True, timeout=timeout)
        need(result.returncode == 0 and len(result.stdout) < 2*1024**2, 'Managed OCI operation failed; no privileged fallback was attempted')
        return result.stdout.strip()

    def verify_host(self):
        need(os.geteuid() != 0, 'Personal OCI must never run as host root')
        protected_file('/usr/bin/podman', self.policy['podmanSHA256'], executable=True)
        protected_file('/usr/bin/crun', self.policy['runtimeSHA256'], executable=True)
        with self.s.directory(HOOKS) as fd:
            info = os.fstat(fd)
            need(info.st_uid == 0 and not info.st_mode & 0o022 and not os.listdir(fd), 'OCI hooks must be a root-owned empty directory')
        protected_file(CDI, self.policy['cdiSHA256'])
        protected_file(ENGINE, hashlib.sha256(ENGINE_RAW).hexdigest())
        # Podman 4.1 searches both default CDI directories. Accept only this
        # one pinned administrator spec; do not let another spec override it.
        for directory, names in ((Path('/etc/cdi'), {'gpuq-nvidia.json'}), (Path('/run/cdi'), set())):
            if not directory.exists():
                need(not names, 'Pinned CDI directory missing'); continue
            with self.s.directory(directory) as fd:
                info = os.fstat(fd)
                need(info.st_uid == 0 and not info.st_mode & 0o022 and set(os.listdir(fd)) == names,
                     'Unpinned CDI specification directory')
        # mounts.conf is independent of containers.conf and must not inject a
        # host secret/socket into every otherwise restricted rootless container.
        for path in (Path('/usr/share/containers/mounts.conf'), Path('/etc/containers/mounts.conf'),
                     self.folder/'home/containers/mounts.conf'):
            if path.exists() or path.is_symlink():
                with self.s.directory(path.parent) as parent:
                    fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
                    try:
                        info = os.fstat(fd)
                        need(stat.S_ISREG(info.st_mode) and info.st_size <= 65536
                             and not any(line.strip() and not line.lstrip().startswith(b'#')
                                         for line in os.read(fd, 65537).splitlines()),
                             'Automatic OCI host mounts are forbidden')
                    finally: os.close(fd)
        version = self.run('version', '--format', '{{.Client.Version}}')
        match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:[+~-].*)?', version)
        need(match and tuple(map(int, match.groups())) >= (4, 1, 0), 'Podman >= 4.1 is required for exact CDI GPU isolation')
        value = json.loads(self.run('info', '--format=json'))
        host = value.get('host', {})
        need(host.get('security', {}).get('rootless') is True and host.get('cgroupVersion') == 'v2'
             and host.get('ociRuntime', {}).get('name') == 'crun', 'Rootless cgroup-v2/crun capability not verified')
        return {'rootless': True, 'gpuDevelopment': False, 'trainingGpu': 'scheduler-exact-cdi', 'podman': version}

    def state_path(self, slug):
        need(isinstance(slug, str) and self.s.SLUG.fullmatch(slug), 'Invalid OCI project')
        return self.folder/'projects'/(slug+'.json')

    @contextlib.contextmanager
    def locked(self, slug):
        path = self.state_path(slug)
        fd = os.open(path.with_suffix('.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1
                 and not info.st_mode & 0o077, 'Invalid OCI project lock')
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            os.close(fd)

    def load(self, slug):
        try:
            value = self.s.read_json(self.state_path(slug))
        except FileNotFoundError:
            return {'schema': 1, 'owner': self.owner, 'project': slug, 'image': self.policy['baseImage'], 'container': None}
        need(set(value) == {'schema', 'owner', 'project', 'image', 'container'} and value['schema'] == 1
             and value['owner'] == self.owner and value['project'] == slug
             and (IMAGE.fullmatch(value['image']) or value['image'] == self.policy['baseImage'])
             and (value['container'] is None or re.fullmatch('gpuq-dev-[a-f0-9]{32}', value['container'])),
             'OCI ownership state is invalid')
        return value

    def checkpoint(self, slug):
        """Caller holds project/OCI lock and has confirmed terminal unit stopped."""
        value = self.load(slug)
        if value['container'] is not None:
            container = json.loads(self.run('container', 'inspect', value['container']))
            need(len(container) == 1, 'Development container identity missing')
            entry = container[0]
            labels = entry.get('Config', {}).get('Labels', {})
            state = entry.get('State', {})
            need(labels.get('io.gpuq.owner') == self.owner and labels.get('io.gpuq.project') == slug
                 and state.get('Running') is False and state.get('Pid') == 0
                 and state.get('Status') in ('exited', 'created', 'configured'), 'Development container is running or ownership is unknown')
            image = self.run('commit', '--pause=false', value['container'], timeout=1800)
            need(IMAGE.fullmatch(image), 'OCI commit did not return an immutable image ID')
            old = value['container']
            value.update(image=image, container=None)
            # Durable head before removing the only writable layer. A crash may
            # leave an unused container, but never loses the acknowledged image.
            self.s.atomic_json(self.state_path(slug), value)
            self.run('rm', old)
        elif not IMAGE.fullmatch(value['image']):
            self.run('pull', '--quiet', value['image'], timeout=1800)
            image = self.run('image', 'inspect', '--format={{.Id}}', value['image'])
            need(IMAGE.fullmatch(image), 'Approved base did not resolve to an immutable local image')
            value['image'] = image
            self.s.atomic_json(self.state_path(slug), value)
        return value

    def publish(self, slug):
        self.verify_host()
        with self.locked(slug):
            value = self.checkpoint(slug)
            return {'schema': 1, 'owner': self.owner, 'project': slug, 'image': value['image']}

    def verify_image(self, slug, receipt):
        need(isinstance(receipt, dict) and set(receipt) == {'schema', 'owner', 'project', 'image'}
             and receipt['schema'] == 1 and receipt['owner'] == self.owner and receipt['project'] == slug
             and isinstance(receipt['image'], str) and IMAGE.fullmatch(receipt['image']), 'OCI release ownership mismatch')
        need(self.run('image', 'inspect', '--format={{.Id}}', receipt['image']) == receipt['image'], 'Published OCI image is missing; no tag fallback allowed')
        return receipt['image']

    def arguments(self, spec, project, terminal, uuids, mounts, control=()):
        need(project.get('environmentMode') == 'oci', 'Not an OCI project')
        need(isinstance(spec.get('argv'), list) and 1 <= len(spec['argv']) <= 256
             and all(isinstance(a, str) and '\x00' not in a and len(a) <= 65536 for a in spec['argv']), 'Invalid OCI argv')
        # All host sources are already-open descriptors owned by the trusted
        # runner, never a user-provided host path. No nested daemon/socket.
        args = ['--cgroups=split', '--cgroupns=private', '--user=0', '--pid=private', '--ipc=private',
                '--uts=private', '--hostname=gpuq-job', '--network=slirp4netns:allow_host_loopback=false',
                '--security-opt=no-new-privileges', '--image-volume=ignore', '--pull=never',
                # The existing parent unit enforces TasksMax=2048 and memory /
                # CPU limits across Podman + conmon + every payload descendant.
                # No competing nested pids controller in a populated unit.
                # gpuq-ray caps its object store at 8 GiB. Reserving only the
                # engine's small default shm forces disk-backed object storage.
                # tmpfs pages remain charged to the existing parent MemoryMax.
                '--log-driver=none', '--pids-limit=-1', '--shm-size=8g', '--workdir=/workspace',
                '--label', 'io.gpuq.owner='+self.owner, '--label', 'io.gpuq.project='+spec['project'],
                '--env=HOME=/home/gpuq', '--env=XDG_CACHE_HOME=/home/gpuq/.cache',
                '--env=GPUQ_OUTPUT_DIR=/outputs', '--env=GPUQ_PROJECT='+spec['project'],
                '--env=GPUQ_PROJECT_ENV_MODE=oci', '--env=GPUQ_OFFLINE_ASSETS=/workspace/offline',
                '--env=GPUQ_CONSOLE_JOB_ID='+spec.get('id', ''), '--env=NCCL_CUMEM_HOST_ENABLE=0',
                '--env=LANG=C.UTF-8', '--env=PYTHONUNBUFFERED=1',
                '--env=NVIDIA_VISIBLE_DEVICES=void', '--unsetenv=CUDA_VISIBLE_DEVICES',
                '--env=GPUQ_PROJECT_RELEASE='+spec.get('release', 'development')]
        for fd, target, readonly in mounts:
            need(type(fd) is int and fd >= 0 and isinstance(target, str) and target.startswith('/')
                 and '..' not in Path(target).parts and ':' not in target, 'Unsafe OCI mount')
            args += ['--volume', '/proc/'+str(os.getpid())+'/fd/'+str(fd)+':'+target+(':ro' if readonly else ':rw')]
        if terminal:
            # Resource/PATH environment is useful in development too, but the
            # scheduler's writable attempt SDK is never mounted there.
            need(not uuids and all(control[i] == '--setenv' for i in range(0, len(control), 3)),
                 'Development OCI cannot have GPUs or scheduler controls')
            args += ['--interactive', '--tty', '--env=TERM=xterm-256color']
        else:
            protected_file(CDI, self.policy['cdiSHA256'])
            for device in cdi_devices(CDI.read_bytes(), uuids):
                args += ['--device', device]
        args += translate_control(list(control))
        return args

    def execute(self, spec, project, terminal, uuids, mounts, *, control=(), pass_fds=()):
        self.verify_host()
        need(os.getuid() != 0, 'Rootless OCI cannot execute as host root')
        flags = self.arguments(spec, project, terminal, uuids, mounts, control)
        # Podman/conmon/crun remain in this scheduler/terminal delegated unit.
        group = next(v.split(':', 2)[2].strip() for v in Path('/proc/self/cgroup').read_text().splitlines() if v.startswith('0::'))
        need(Path(group).name.startswith('amax-term-' if terminal else 'gpuq-')
             and Path(group).name.endswith('.service'), 'OCI must be owned by an authorized systemd unit')
        env = {'PATH': '/usr/bin:/bin', 'HOME': str(Path.home()),
               'XDG_RUNTIME_DIR': '/run/user/'+str(os.getuid()),
               'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/'+str(os.getuid())+'/bus'}
        unit = Path(group).name
        subprocess.run(['/usr/bin/systemctl', '--user', 'set-property', '--runtime', unit, 'Delegate=yes'],
                       env=env, check=True, timeout=5)
        shown = subprocess.run(['/usr/bin/systemctl', '--user', 'show', unit,
            '--property=Delegate,KillMode,MemoryMax,TasksMax,ControlGroup'], env=env,
            check=True, text=True, capture_output=True, timeout=5)
        state = dict(line.split('=',1) for line in shown.stdout.splitlines() if '=' in line)
        need(state.get('Delegate') == 'yes' and state.get('KillMode') == 'control-group'
             and state.get('TasksMax') == '2048' and state.get('ControlGroup') == group
             and state.get('MemoryMax','').isdigit() and int(state['MemoryMax']) > 0,
             'OCI parent resource/cancellation boundary is not verified')
        if terminal:
            with self.locked(spec['project']):
                head = self.checkpoint(spec['project'])
                name = 'gpuq-dev-'+uuid.uuid4().hex
                # Store the intended exact name before create. Unknown outcome
                # retains this identity; never mint a replacement implicitly.
                head['container'] = name
                self.s.atomic_json(self.state_path(spec['project']), head)
                result = subprocess.run(self.command('create', '--name', name, *flags,
                    '--entrypoint', spec['argv'][0], head['image'], *spec['argv'][1:]),
                    env=self.env, text=True, capture_output=True, pass_fds=pass_fds, timeout=60)
                need(result.returncode == 0, 'OCI development creation unconfirmed; inspect the retained identity')
            return subprocess.call(self.command('start', '--attach', '--interactive', name), env=self.env, pass_fds=pass_fds)
        image = self.verify_image(spec['project'], project['meta']['oci'])
        name = 'gpuq-job-'+uuid.uuid4().hex
        return subprocess.call(self.command('run', '--rm', '--name', name, *flags,
                               '--entrypoint', spec['argv'][0], image, *spec['argv'][1:]),
                               env=self.env, pass_fds=pass_fds)


def run_project(config, spec, project, terminal, uuids, workfd, project_fds,
                dataset_fds, datafd=None, runtimefd=None, resourcefd=None, cgroupfd=None):
    """Both existing scheduler profiles enter here after allocation/limits."""
    owner = PersonalOCI(config, spec['userId'])
    mounts = [(workfd, '/workspace', not terminal), (project_fds['home'], '/home/gpuq', False),
              (project_fds['output'], '/outputs', False)]
    mounts += [(fd, target, True) for fd, target in dataset_fds]
    if datafd is not None:
        need(terminal, 'Mutable data workspace is only for development')
        mounts.append((datafd, '/data2', False))
    if runtimefd is not None:
        mounts.append((runtimefd, '/run/gpuq/runtime', False))
    if resourcefd is not None:
        mounts.append((resourcefd, '/run/gpuq/resources.json', True))
    # Keep the job's exact resource view read-only, not the host cgroup tree.
    if cgroupfd is not None:
        mounts.append((cgroupfd, '/sys/fs/cgroup', True))
    control, extra = ([], []) if terminal else module('training-control').prepare(
        config, spec, project['code'], project, os.environ)
    try:
        # Add helpers without hiding an image's own Conda/venv PATH. No host
        # environment forwarding: the immutable image supplies its base PATH.
        image = project['meta']['oci']['image'] if not terminal else owner.load(spec['project'])['image']
        if not IMAGE.fullmatch(image):
            # A new development base is pulled/checkpointed by execute(). A
            # conservative standard PATH suffices until the first checkpoint.
            image_path = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        else:
            environment = json.loads(owner.run('image', 'inspect', '--format={{json .Config.Env}}', image)) or []
            paths = [v[5:] for v in environment if isinstance(v, str) and v.startswith('PATH=')]
            need(len(paths) <= 1, 'Ambiguous OCI image PATH')
            image_path = paths[0] if paths else '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        control += ['--setenv', 'PATH', '/opt/gpuq/bin:'+image_path]
        if resourcefd is not None:
            budget = json.loads(os.pread(resourcefd, 65536, 0))
            for key, value in module('job-resources').resource_environment(budget).items():
                control += ['--setenv', key, value]
        if runtimefd is not None:
            for key, value in {'RAY_TMPDIR':'/run/gpuq/runtime','GPUQ_RAY_TEMP_DIR':'/run/gpuq/runtime/ray',
                               'RAY_object_spilling_directory':'/tmp/gpuq-ray-spill'}.items():
                control += ['--setenv', key, value]
        for name in ('gpuq-network', 'gpuq-ray', 'job-resources.py'):
            path = HERE/name
            if path.exists():
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                extra.append(fd)
                mounts.append((fd, '/opt/gpuq/bin/'+name, True))
        # FDs belong to the live runner. Podman uses /proc/<runner>/fd paths,
        # not its own re-exec fd table; untrusted code never receives these FDs.
        return owner.execute(spec, project, terminal, uuids, mounts, control=control)
    finally:
        for fd in extra:
            os.close(fd)
