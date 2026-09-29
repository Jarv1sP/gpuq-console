#!/usr/bin/env python3
"""Run every standalone Python test file, including storage/backend regressions."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
for test in sorted((root / 'tests').glob('*.test.py')):
    print('\n=== ' + test.name + ' ===', flush=True)
    result = subprocess.run([sys.executable, str(test)], cwd=root)
    if result.returncode:
        raise SystemExit(result.returncode)
