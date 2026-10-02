#!/usr/bin/python3
"""Temporary fixture entrypoint: production worker, only data mount mocked."""
import importlib.util
from pathlib import Path
import sys
path=Path(__file__).resolve().parent/'node-runtime-entry.py'
spec=importlib.util.spec_from_file_location('real_transfer_fixture_node',path);node=importlib.util.module_from_spec(spec);sys.modules[spec.name]=node;spec.loader.exec_module(node)
node.dataset_mount_check=lambda config:None  # Disposable /tmp, not production /data2.
if len(sys.argv)!=4 or sys.argv[1]!='--transfer-worker':raise SystemExit('Only fixture transfer worker allowed')
raise SystemExit(node.transfers().worker(sys.argv[2],int(sys.argv[3])))
