"""Submission contract for explicit single-GPU sharing."""

from typing import Any


def validate_sharing(
    share_gpu: Any,
    vram_mb: Any,
    *,
    placement: str,
    gpu_count: int,
    elastic: bool,
    mode: str,
) -> tuple[bool, int | None]:
    if not isinstance(share_gpu, bool):
        raise ValueError("share_gpu must be boolean")
    if not share_gpu:
        if vram_mb is not None:
            raise ValueError("vram_mb requires --share")
        return False, None
    if placement != "pinned" or gpu_count != 1 or elastic or mode != "queue":
        raise ValueError("--share requires one explicit --gpu and queue mode")
    if (
        isinstance(vram_mb, bool)
        or not isinstance(vram_mb, int)
        or not 1 <= vram_mb <= 2**31 - 1
    ):
        raise ValueError("--share requires a positive --vram-gb budget")
    return True, vram_mb
