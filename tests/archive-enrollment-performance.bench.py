"""Disposable metadata benchmark, not a production upload/throughput test.

Run: python3 tests/archive-enrollment-performance.bench.py --entries 164690
      python3 tests/archive-enrollment-performance.bench.py --entries 450000
The old path below is the former enrollment check, including its two complete
registry reads and READY JSON comparison while holding the global cache lock.
Peer-like probes deliberately use a short 50 ms lock budget to measure admission
contention; their counts are NOT predictions of production 2-second timeouts.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import json
from pathlib import Path
import threading
import time
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('enrollment_fixture',
    Path(__file__).with_name('archive-enrollment-performance.test.py'))
T = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(T)
D = T.D


def previous(f):
    with f.cache._locked():
        ref = {k:f.args[k] for k in ('dataset','version')}
        identity = f.archive._single_locked(T.USER, ref, ready=True, protected=True)
        if f.cache._version_entry_exists(f.paths['.staging']): raise ValueError('staging')
        record = f.cache._record(T.ADMIN, **ref)
        raw = D._json_bytes(record['manifest'])
        if len(raw) > T.A.MAX_MANIFEST or hashlib.sha256(raw).hexdigest() != f.version:
            raise ValueError('manifest')
        return dict(protocol=1,machine='cold-node',userId=T.USER,**ref,state='READY',role='protected',
            manifestSha256=f.version,manifestBytes=len(raw),
            registration=f.archive._registration_binding(T.USER,ref,identity))


def measure(f, action, repetitions):
    holds = []; samples = dict(acquired=0,busy=0); stop = threading.Event()
    main = threading.get_ident(); original = f.cache._locked
    @contextlib.contextmanager
    def timed():
        with original():
            started = time.perf_counter()
            try: yield
            finally:
                if threading.get_ident() == main: holds.append(time.perf_counter()-started)
    def peer():
        while not stop.is_set():
            try:
                with D.wait_for_locks(timeout=0.05,total=0.05):
                    with f.cache._locked(): samples['acquired'] += 1
            except D.CacheBusy: samples['busy'] += 1
            stop.wait(0.01)
    with patch.object(f.cache,'_locked',timed), \
            patch.object(f.cache,'_record',wraps=f.cache._record) as record:
        thread = threading.Thread(target=peer); thread.start(); started = time.perf_counter()
        try:
            values = [action() for _ in range(repetitions)]
        finally:
            elapsed = time.perf_counter()-started; stop.set(); thread.join(2)
        assert not thread.is_alive()
    return values[-1], dict(calls=repetitions,seconds=elapsed,registryParses=record.call_count,
        globalLockHeldSeconds=sum(holds),maxGlobalLockHeldSeconds=max(holds,default=0),
        peerProbeBudgetMs=50,peerProbes=samples)


def main():
    p = argparse.ArgumentParser(); p.add_argument('--entries',type=int,choices=[164690,450000],default=164690)
    args = p.parse_args(); f = T.EnrollmentFixture(args.entries)
    try:
        old, before = measure(f, lambda:previous(f), 2)
        cold, first = measure(f, f.check, 1)
        # New adapters mimic separate executor RPC processes reading the memo.
        warm, repeated = measure(f, lambda:T.M.StorageArchive(f.node).enrollment_check(f.args), 20)
        assert old == cold == warm
        assert repeated['registryParses'] == 0
        assert before['registryParses'] == 4 and first['registryParses'] == 1
        assert repeated['maxGlobalLockHeldSeconds'] < before['maxGlobalLockHeldSeconds']
        print(json.dumps(dict(entries=args.entries,manifestBytes=cold['manifestBytes'],
            fixture='metadata-only; no payload files or actual publication',
            previous=before,cold=first,warm=repeated),sort_keys=True))
    finally: f.close()


if __name__ == '__main__': main()
