#!/usr/bin/env python3
"""Temporary protocol fixture: real Commands/worker, unprivileged local shell.

No sudo/systemd/GPU/SSH. The ONLY script accepted by this test adapter is a
fixed printf. activity() is simulated, so this does not establish ROOT/cgroup
production acceptance. The fixture exercises the existing receipt/owner API.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

path = Path(__file__).resolve().parents[1] / 'deploy' / 'admin-command.py'
spec = importlib.util.spec_from_file_location('existing_admin_command', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LocalCommands(module.Commands):
    def activity(self, identifier):
        return False  # Explicit mock; no live systemd lifecycle check.

    def run_system(self, args, timeout=8):
        if args[0] != '/usr/bin/systemd-run':
            raise ValueError('No real system command is allowed in this fixture')
        self.worker(args[-1])
        return subprocess.CompletedProcess(args, 0, '', '')


request = json.load(sys.stdin)
operation = request['operation']
args = dict(request['args'])
if args.pop('hostAdmin', False) is not True:
    raise ValueError('Expected server-owned administrator context')
if operation == 'host.exec' and args.get('argv') != [
        '/bin/bash', '--noprofile', '--norc', '-c', 'printf "native fixture\\n"']:
    raise ValueError('Only the fixed non-destructive fixture script is allowed')
root = Path(sys.argv[1])
if operation == 'host.exec' and args.get('cwd') != str(root):
    raise ValueError('The fixture runs only inside its temporary directory')
print(json.dumps(LocalCommands(root).call(operation, args)))
