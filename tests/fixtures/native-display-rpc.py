"""Real node + CLI + Coordinator/SQLite test bridge; CUDA/systemd are fake."""
import importlib.util
import json
from pathlib import Path
import sys
source=Path(__file__).resolve().parents[1]/'node-task-display.test.py'
spec=importlib.util.spec_from_file_location('metadata_real_bridge',source);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
case=module.NodeDisplay();case.setUp()
print(json.dumps({'ready':True}),flush=True)
try:
    for line in sys.stdin:
        request=json.loads(line)
        try:
            operation=request['operation']
            if operation=='inspect':
                result={'jobs':[{k:j[k] for k in ('id','submit_key','name','owner','display_metadata')} for j in case.store.list_jobs()],
                    'table':'\n'.join(module.cli.format_status_table(case.coordinator.handle_api('status',{})['jobs'],{})),
                    'submitCalls':sum(c[0]=='submit' for c in case.commands)}
            elif operation=='erase-display':
                case.store._get_connection().execute("UPDATE jobs SET display_json='{}'")
                result={}
            else:
                result=case.node.process(operation,request['args'])
            reply={'id':request['id'],'ok':True,'result':result}
        except Exception as error:reply={'id':request['id'],'ok':False,'error':str(error)}
        print(json.dumps(reply,ensure_ascii=False),flush=True)
finally:case.doCleanups()
