#!/usr/bin/env python3
"""Run a downloaded approval CLI in a real local TTY and always decline.

No root commands or arbitrary interactive input: the only reply is NO.
"""
import errno
import json
import os
import pty
import select
import subprocess
import sys
import time

master, slave = pty.openpty()
process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = bytearray()
answered = False
deadline = time.monotonic() + 15
try:
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.1)[0]:
            if process.poll() is not None:
                break
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        output.extend(chunk)
        if not answered and '输入 EXECUTE'.encode() in output:
            os.write(master, b'NO\n')
            answered = True
    if process.poll() is None:
        process.wait(timeout=2)
    if not answered:
        raise RuntimeError('The approval confirmation was not displayed')
    print(json.dumps({'exitCode': process.returncode, 'output': output.decode('utf8')}))
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
