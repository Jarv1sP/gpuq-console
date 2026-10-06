"""Real disposable node watch/lease cleanup contract, never a production node."""
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import sys
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).parent))
spec=importlib.util.spec_from_file_location('completion_node_fixture',Path(__file__).with_name('node-storage-preparation.test.py'))
F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F)
fixture=F.PreparedLeaseIntegration();fixture.setUp()
try:
    node=fixture.node;node.CONFIG['storageArchive']['enabled']=False
    shutil.copy2(F.F.DEPLOY/'job-observation.py',node.HERE/'job-observation.py')
    node.acquire_datasets(fixture.job)
    saved=node.ROOT/'jobs'/(fixture.job['id']+'.json');saved.write_text(json.dumps(fixture.job));before_bytes=saved.read_bytes()
    native='J0123456789ab';attempt='A'+'a'*32
    with closing(sqlite3.connect(node.CONFIG['database'])) as db:
        db.execute('ALTER TABLE jobs ADD COLUMN state TEXT');db.execute('ALTER TABLE jobs ADD COLUMN version INTEGER')
        db.execute('INSERT INTO jobs VALUES(?,?,?,?)',(native,fixture.job['id'],'SUCCEEDED',9))
        db.execute('CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT,event_type TEXT,created_at REAL)')
        db.execute('INSERT INTO events VALUES(12,?,?,200)',(native,'JOB_RETRIED'));db.commit()
    data={'job':{'id':native,'submit_key':fixture.job['id'],'state':'SUCCEEDED','version':9,'active_attempt_id':None},
          'attempts':[{'id':attempt,'job_id':native,'ordinal':2,'state':'EXITED_SUCCESS','exit_code':0,'failure_reason':None,
                       'started_at':250,'finished_at':300,'unit_name':'gpuq-fixture','gpu_indices':[0]}],
          'leases':[],'scale_up_reservations':[]}
    expected={'nodeJobId':native,'attemptId':attempt,'attemptOrdinal':2,'nativeVersion':9}
    args={'job':fixture.job,'expectedNodeJobId':native}
    with patch.object(node,'gpu',return_value=data) as gpu,patch.object(node,'dataset_unit_stopped',return_value=True):
        before=node.process('watch',args)
        assert before['state']=='UNKNOWN' and before['nativeObservation']['state']=='SUCCEEDED'
        assert len(fixture.leases())==1
        released=node.storage_lease_operation('storage.lease.cancel',{'job':fixture.job,'expectedNative':expected})
        after=node.process('watch',args)
        assert after['state']=='SUCCEEDED' and after['assignedIndices']==[]
        assert fixture.leases()==[] and not fixture.receipt().exists()
        assert not (node.ROOT/'jobs'/(fixture.job['id']+'.canceled')).exists()
        assert saved.read_bytes()==before_bytes
        assert all(c.args==('show',native) for c in gpu.call_args_list)
    print(json.dumps({'spec':fixture.job,'before':before,'released':released,'after':after,'unchangedSpec':True,'datasetLeasesAfter':0}))
finally:
    fixture.tearDown();fixture.doCleanups()
