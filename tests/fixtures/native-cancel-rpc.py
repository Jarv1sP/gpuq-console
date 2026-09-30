#!/usr/bin/env python3
"""Actual native Store/cancel/finalize and node protocol, fake CUDA/systemd only."""
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
from unittest.mock import patch


source = Path(__file__).resolve().parents[1] / 'node-terminal.test.py'
spec = importlib.util.spec_from_file_location('native_cancel_fixture', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
case = module.NativeTerminal()
case.setUp()
case.running()
case.node.process('sync', {'job': case.job})


def state():
    data = case.core._api_show({'job_id': case.native['id']})
    with closing(sqlite3.connect(f'file:{case.store.path}?mode=ro', uri=True)) as db:
        leases = db.execute('SELECT count(*) FROM leases WHERE job_id=?', (case.native['id'],)).fetchone()[0]
        assert leases == len(data['leases'])
    return {'jobState': data['job']['state'], 'attemptState': data['attempts'][0]['state'], 'leases': leases}


print(json.dumps({'ready': True, 'job': case.job, 'native': state()}), flush=True)
try:
    for line in sys.stdin:
        request = json.loads(line)
        try:
            action = request['operation']
            if action == 'drain-native':
                case.drain()
                result = state()
            elif action == 'state':
                result = state()
            else:
                assert action in ('sync', 'cancel'), action
                assert request['args']['job'] == case.job, 'immutable node specification changed'
                before = len(case.commands)
                if request.get('sqlError'):
                    with patch.object(case.node.sqlite3, 'connect', side_effect=sqlite3.OperationalError('test read unavailable')):
                        result = case.node.process(action, request['args'])
                else:
                    result = case.node.process(action, request['args'])
                result = {'node': result, 'calls': case.commands[before:], 'native': state()}
            reply = {'id': request['id'], 'ok': True, 'result': result}
        except Exception as error:
            reply = {'id': request['id'], 'ok': False, 'error': str(error)}
        print(json.dumps(reply), flush=True)
finally:
    case.doCleanups()
