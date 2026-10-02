"""Synthetic local mount tables for disposable storage fixtures only."""
import os
from pathlib import Path
from unittest.mock import patch


def local_data_mounts(*points):
    """Keep real directory/FD guards while simulating dedicated test disks.

    Tests cannot mount actual block devices. Only /proc/self/mountinfo is
    substituted; all file reads, inode checks and O_NOFOLLOW operations remain
    real inside their TemporaryDirectory.
    """
    original = Path.read_text
    points = [Path(point).resolve() for point in points]

    def read_text(path, *args, **kwargs):
        if str(path) != "/proc/self/mountinfo":
            return original(path, *args, **kwargs)
        rows = ["1 0 999:999 / / rw - ext4 /dev/test-root rw"]
        for index, point in enumerate(points, start=2):
            device = point.stat().st_dev
            target = str(point).replace("\\", r"\134").replace(" ", r"\040")
            rows.append(f"{index} 1 {os.major(device)}:{os.minor(device)} / {target} rw - ext4 /dev/test-data rw")
        return "\n".join(rows) + "\n"

    return patch.object(Path, "read_text", new=read_text)
