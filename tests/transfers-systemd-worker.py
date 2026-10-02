#!/usr/bin/python3
"""Temporary worker with synthetic mountinfo and real production FS guards."""
import importlib.util
from pathlib import Path
import sys
path=Path(__file__).resolve().parent/'node-runtime-entry.py'
spec=importlib.util.spec_from_file_location('real_transfer_fixture_node',path);node=importlib.util.module_from_spec(spec);sys.modules[spec.name]=node;spec.loader.exec_module(node)
if len(sys.argv)!=4 or sys.argv[1]!='--transfer-worker':raise SystemExit('Only fixture transfer worker allowed')
helper=importlib.util.spec_from_file_location('transfer_fixture_mounts',path.parent/'storage_test_helpers.py');mounts=importlib.util.module_from_spec(helper);helper.loader.exec_module(mounts)
# A systemd child cannot inherit the parent's Python patch. Reuse exactly the
# same synthetic table; keep mount preflight, real FD/inode checks and rename.
with mounts.local_data_mounts(node.CONFIG['datasets']['mountPoint']):
    raise SystemExit(node.transfers().worker(sys.argv[2],int(sys.argv[3])))
