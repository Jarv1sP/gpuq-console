#!/usr/bin/python3
"""Read-only collector, separated from the public web process and its credentials."""
import concurrent.futures
import datetime
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path("/opt/amax-console/collector")
TARGET = Path("/opt/amax-console/status/snapshot.json")
HOSTS = {n['id']: n for n in json.loads(Path('/opt/amax-console/inventory.json').read_text())['nodes']}


def collect(item):
    name, host = item
    try:
        result = subprocess.run([
            "/usr/bin/ssh", "-F", "/dev/null", "-T", "-i", str(ROOT / "id_ed25519"),
            "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
            "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
            "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={ROOT / 'known_hosts'}",
            host['user']+'@'+host['address'], "status"], stdin=subprocess.DEVNULL, capture_output=True,
            text=True, timeout=25)
        if result.returncode or len(result.stdout) > 2_000_000:
            raise ValueError("collector SSH failed")
        data = json.loads(result.stdout)
        if data.get("version") != 1 or not isinstance(data.get("gpus"), list):
            raise ValueError("bad snapshot")
        return {**data, "id": name, "reachable": True}
    except (ValueError, OSError, subprocess.SubprocessError):
        return {"id": name, "reachable": False, "error": "当前无法读取机器状态", "gpus": [],
                "gpuq": {"connected": False, "jobs": []}}


def main():
    os.umask(0o027)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        hosts = list(pool.map(collect, HOSTS.items()))
    snapshot = {"version": 1, "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "hosts": hosts}
    fd, name = tempfile.mkstemp(prefix=".snapshot-", dir=TARGET.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(snapshot, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(name, 0o640)
        os.chown(name, 0, 1000)
        os.replace(name, TARGET)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    print(json.dumps({"reachable": sum(h["reachable"] for h in hosts),
                      "gpuq": sum(h["gpuq"]["connected"] for h in hosts), "hosts": len(hosts)}))


if __name__ == "__main__":
    main()
