#!/usr/bin/python3
"""Forced SSH command: read fixed GPU/GPUQ status only, never accept commands."""
import csv
import datetime
import io
import json
import os
import subprocess
from pathlib import Path

CONFIG=json.loads((Path(__file__).resolve().parent/'node-config.json').read_text())
ENV = {"PATH": "/usr/bin:/bin", "HOME": str(Path.home()), "LANG": "C.UTF-8",
       "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}"}


def command(argv, timeout=10):
    result = subprocess.run(argv, env=ENV, capture_output=True, text=True, timeout=timeout)
    if result.returncode or len(result.stdout) > 2_000_000:
        raise ValueError("status command failed")
    return result.stdout


def probe():
    output = {"version": 1, "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "gpus": [], "gpuq": {"connected": False, "jobs": []}}
    try:
        rows = csv.reader(io.StringIO(command([
            "/usr/bin/nvidia-smi", "--query-gpu=index,name,memory.total,memory.used,utilization.gpu",
            "--format=csv,noheader,nounits"])))
        output["gpus"] = [{"index": int(row[0]), "model": row[1].strip(), "memoryTotalMiB": int(row[2]),
                           "memoryUsedMiB": int(row[3]), "utilization": int(row[4])} for row in rows]
    except (ValueError, OSError, subprocess.SubprocessError):
        output["gpuError"] = "GPU status unavailable"
    if os.path.isfile(CONFIG['gpu']):
        try:
            status = json.loads(command([CONFIG['gpu'], "--json", "q", "--limit", "100"], 12))
            daemon = status.get("daemon", {})
            allowed = ("id", "name", "owner", "state", "gpu_count", "assigned_gpu_count",
                       "assigned_gpu_indices", "priority_name", "share_gpu", "created_at")
            output["gpuq"] = {
                "connected": True, "health": daemon.get("health", "unknown"),
                "observeOnly": daemon.get("observe_only"),
                "schedulableIndices": daemon.get("schedulable_gpu_indices", []),
                "jobs": [{key: job.get(key) for key in allowed} for job in status.get("jobs", [])[:100]],
                "limit": 100,
            }
        except (ValueError, OSError, subprocess.SubprocessError):
            output["gpuq"]["error"] = "GPUQ status unavailable"
    else:
        output["gpuq"]["error"] = "GPUQ not installed at the managed entry point"
    return output


if __name__ == "__main__":
    # SSH_ORIGINAL_COMMAND and stdin are intentionally ignored.
    print(json.dumps(probe(), ensure_ascii=False))
