"""Opt-in real user-systemd/cgroup + pinned TLS + immutable-storage smoke.
Only randomized gpuq-transfer fixture units and temporary files are touched.
Requires user manager, CPU/memory controllers and loopback sockets.
"""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import time
from unittest.mock import patch
import uuid

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('real_systemd_transfer_fixture',HERE/'transfers.test.py');F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F)
f=F.Transfers();f.setUp();units=[]
try:
    # Keep real production executor/worker. Replace only its fixture entrypoint
    # to bypass the known production /data2 mount preflight in disposable /tmp.
    shutil.move(f.target.HERE/'node-executor.py',f.target.HERE/'node-runtime-entry.py')
    shutil.copy2(HERE/'transfers-systemd-worker.py',f.target.HERE/'node-executor.py')
    f.target.atomic_json(f.target.HERE/'node-config.json',f.target.CONFIG)
    for p in f.patches:p.stop()
    def wait(key,states,seconds=30):
        until=time.monotonic()+seconds
        while time.monotonic()<until:
            result=f.dst.status({'id':key,'userId':F.USER})
            if result['state'] in states:return result
            time.sleep(.1)
        raise AssertionError('Timed out: '+json.dumps(result))
    units.append(f.dst.unit(f.key,1));f.dst.start(f.args)
    result=wait(f.key,{'SUCCEEDED','FAILED'})
    assert result['state']=='SUCCEEDED',result
    assert result['version']==f.version,result
    assert f.dst.activity(units[-1]) is False
    key=str(uuid.uuid4());args={**f.args,'id':key,'name':'cancelled'}
    args['source']=f.src.prepare({'id':key,'userId':F.USER,'reference':args['reference']})
    original=f.src.read
    def slow(request,token):
        if request.get('action')=='get':time.sleep(.8)
        return original(request,token)
    units.append(f.dst.unit(key,1))
    with patch.object(f.src,'read',side_effect=slow):
        f.dst.start(args);result=wait(key,{'RUNNING'})
        # Wait until at least one durable payload chunk has landed.
        until=time.monotonic()+20
        while time.monotonic()<until:
            current=f.dst.status({'id':key,'userId':F.USER})
            if current['bytes']>0:break
            time.sleep(.05)
        assert current['bytes']>0,current
        properties=subprocess.run(['/usr/bin/systemctl','--user','show',units[-1],'--property=MemoryMax,CPUQuotaPerSecUSec,KillMode,ControlGroup'],env=f.target.ENV,check=True,capture_output=True,text=True).stdout
        assert 'MemoryMax=2147483648' in properties,properties
        assert 'CPUQuotaPerSecUSec=2s' in properties,properties
        assert 'KillMode=control-group' in properties,properties
        canceled=f.dst.cancel({'id':key,'userId':F.USER})
        assert canceled['state']=='CANCELED',canceled
        assert f.dst.activity(units[-1]) is False
        assert f.dst.path(key,'.progress.json').exists(),'Cancellation must retain partial state'
        try:f.dst.resume({'id':key,'userId':F.USER})
        except ValueError:pass
        else:raise AssertionError('Canceled job resumed')
    print('Real systemd transfer passed: detached worker, pinned TLS, READY SHA/version, CPU/memory properties, retained partial and cgroup-confirmed cancel.')
finally:
    for unit in units:subprocess.run(['/usr/bin/systemctl','--user','stop',unit],env=f.target.ENV,capture_output=True,timeout=10)
    f.tearDown()
