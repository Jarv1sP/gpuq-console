"""MANUAL acceptance payload: run ONLY as an authorized queued eight-GPU job.

Submit this file's contents with argv ["gpuq-ray", "exec", "python", "-c", SOURCE]
against the selected existing read-only project release. This is NOT a unit
test and must never be run on the host or added to automatic test discovery.
"""
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time


def counters():
    result = {}
    for name in ('cpu.max', 'memory.max', 'memory.current', 'memory.peak', 'pids.max',
                 'pids.current', 'pids.peak', 'pids.events', 'memory.events'):
        path = Path('/sys/fs/cgroup') / name
        if path.exists():
            result[name] = path.read_text().strip()
    return result


def events(snapshot, name):
    return dict((key, int(value)) for key, value in (line.split() for line in snapshot[name].splitlines()))


class StartupProcessObserver:
    """TEST ONLY: observe Ray's own children, never log their argv or env.

    Ray 2.58 sends pre-logger raylet stderr to DEVNULL. In this bounded manual
    probe only, inherit the task's stderr so loader/flag failures are visible.
    The original ProcessInfo, fate-sharing and all resource limits are retained.
    """
    def __init__(self, services, emit=print, background=True):
        self.services, self.original, self.emit = services, services.start_ray_process, emit
        self.records, self.children = [], []
        self.lock, self.stop = threading.RLock(), threading.Event()
        self.started = time.monotonic()
        self.wrapper = self.start
        services.start_ray_process = self.wrapper
        self.thread = threading.Thread(target=self.watch, name='gpuq-ray-probe-observer', daemon=True) if background else None
        if self.thread: self.thread.start()

    def record(self, **fields):
        with self.lock:
            event = {'elapsedSeconds': round(time.monotonic() - self.started, 3), **fields}
            if len(self.records) >= 128: return
            self.records.append(event)
            self.emit('GPUQ_RAY_PROCESS ' + json.dumps(event), flush=True)

    def start(self, *args, **kwargs):
        kind = kwargs.get('process_type', args[1] if len(args) > 1 else 'unknown')
        kind = kind if isinstance(kind, str) and kind.replace('_', '').isalnum() and len(kind) <= 64 else 'unknown'
        # Preserve any caller-specified file/pipe. Only undo Ray's DEVNULL for
        # raylet's early error stream; C++ later redirects to its usual log.
        if kind == 'raylet' and kwargs.get('stderr_file') == subprocess.DEVNULL:
            kwargs = {**kwargs, 'stderr_file': None}
        self.record(phase='spawn', processType=kind, pid=None, poll=None)
        try: info = self.original(*args, **kwargs)
        except BaseException as error:
            self.record(phase='spawn-error', processType=kind, pid=None, poll=None, errorType=type(error).__name__)
            raise
        process = info.process
        status = process.poll()
        with self.lock:
            if len(self.children) < 32: self.children.append([kind, process, status])
        self.record(phase='started', processType=kind, pid=process.pid, poll=status)
        return info

    def sample(self, final=False):
        with self.lock:
            for child in self.children:
                kind, process, previous = child
                status = process.poll()
                if final or status != previous:
                    self.record(phase='before-shutdown' if final else 'exit', processType=kind, pid=process.pid, poll=status)
                    child[2] = status

    def watch(self):
        while not self.stop.wait(.2): self.sample()

    def close(self):
        self.stop.set()
        if self.thread: self.thread.join(timeout=1)
        self.sample(final=True)
        if self.services.start_ray_process is self.wrapper:
            self.services.start_ray_process = self.original
        return list(self.records)


budget = json.loads(Path('/run/gpuq/resources.json').read_text())
assert budget['gpuCount'] == 8, 'Requires an actual eight-GPU allocation'
assert budget['cpuLimit'] == 32 and budget['memoryLimitBytes'] == 256 * 1024 ** 3
assert os.environ.get('RAY_TMPDIR') == '/run/gpuq/runtime', 'Managed diagnostics runtime required'
assert os.environ.get('RAY_worker_num_grpc_internal_threads') == '2', 'Run via gpuq-ray exec'
assert os.environ.get('RAY_object_spilling_directory') == '/tmp/gpuq-ray-spill'
initial = counters()
assert int(initial['pids.max']) == budget['pidsLimit'] == 2048
readonly = {}
for filename in ('/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/memory.max',
                 '/sys/fs/cgroup/pids.max', '/run/gpuq/resources.json'):
    try:
        descriptor = os.open(filename, os.O_WRONLY)
    except OSError as error:
        assert error.errno in (errno.EROFS, errno.EACCES, errno.EPERM), error
        readonly[filename] = True
    else:
        os.close(descriptor)
        raise AssertionError('Writable job control/metadata file: ' + filename)
import ray
from ray._private import services, utils

automatic = {'cpu': utils.get_num_cpus(), 'memory': utils.get_cgroup_mem_stats()[1]}
assert automatic == {'cpu': 32, 'memory': 256 * 1024 ** 3}, automatic
kwargs = json.loads(subprocess.check_output(['gpuq-ray', 'init-kwargs'], text=True))
assert kwargs['object_spilling_directory'] == '/tmp/gpuq-ray-spill'
assert type(kwargs['num_cpus']) is int and kwargs['num_cpus'] == 32
started = time.time()
report = {'budget': budget, 'automaticDetection': automatic, 'rayVersion': ray.__version__,
          'python': sys.version, 'hostCpuCountInformationalOnly': os.cpu_count(),
          'initial': initial, 'readOnlyControls': readonly, 'passed': False}
print(json.dumps({'phase': 'starting', **report}), flush=True)
startup_observer = StartupProcessObserver(services)

try:
    ray.init(**kwargs)
    resources = ray.cluster_resources()
    assert resources['CPU'] == 32 and resources['GPU'] == 8, resources
    assert resources['memory'] + resources['object_store_memory'] <= budget['memoryLimitBytes'] * .91

    @ray.remote(num_cpus=4, num_gpus=1, max_restarts=0, max_task_retries=0)
    class GPUActor:
        def check(self):
            import torch
            assert torch.cuda.device_count() == 1, torch.cuda.device_count()
            tensor = torch.ones((64, 64), device='cuda')
            value = float((tensor @ tensor).sum().item())
            torch.cuda.synchronize()
            props = torch.cuda.get_device_properties(0)
            result = {'pid': os.getpid(), 'gpuIds': ray.get_gpu_ids(),
                      'visibleDevices': os.environ.get('CUDA_VISIBLE_DEVICES'),
                      'gpuName': props.name, 'gpuUuid': str(getattr(props, 'uuid', 'unavailable')),
                      'cudaResult': value, 'assigned': ray.get_runtime_context().get_assigned_resources()}
            print('GPUQ_EIGHT_ACTOR_OK ' + json.dumps(result), flush=True)
            return result

    actors = [GPUActor.remote() for _ in range(8)]
    results = ray.get([actor.check.remote() for actor in actors], timeout=150)
    assert len({result['pid'] for result in results}) == 8
    assert len({str(result['gpuIds'][0]) for result in results}) == 8
    assert all(result['cudaResult'] == 262144.0 for result in results)
    assert all(result['assigned'].get('CPU') == 4 and result['assigned'].get('GPU') == 1 for result in results)
    final = counters()
    assert events(final, 'pids.events')['max'] == events(initial, 'pids.events')['max'], final
    for key in ('oom', 'oom_kill'):
        assert events(final, 'memory.events').get(key, 0) == events(initial, 'memory.events').get(key, 0), final
    assert int(final['pids.current']) < budget['pidsLimit'], final
    report.update({'passed': True, 'resources': resources, 'actors': results, 'final': final})
finally:
    report['startupProcesses'] = startup_observer.close()
    report['elapsedSeconds'] = round(time.time() - started, 3)
    report['lastCounters'] = counters()
    if not report['passed']:
        report['startupLogs'] = []
        sessions = sorted(Path('/run/gpuq/runtime/ray').glob('session_*'))
        for session in sessions[-2:]:
            if session.is_symlink(): continue
            for path in sorted((session/'logs').glob('*'))[:32]:
                if path.is_file() and not path.is_symlink():
                    with path.open('rb') as stream:
                        stream.seek(max(0,path.stat().st_size-3000))
                        report['startupLogs'].append({'file':path.name,'tail':stream.read(3000).decode(errors='replace')})
        report['networkInfo'] = subprocess.run(['ip','-brief','address'],capture_output=True,text=True).stdout
    output = Path(os.environ.get('GPUQ_OUTPUT_DIR', '/workspace')) / 'ray-eight-gpu-probe.json'
    output.write_text(json.dumps(report, indent=2, sort_keys=True))
    print('GPUQ_EIGHT_GPU_REPORT ' + json.dumps(report, sort_keys=True), flush=True)
    ray.shutdown()
