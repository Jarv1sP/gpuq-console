"""Local PTY exchange regression tests; no SSH, credentials, sudo or systemd."""
import base64
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


class TerminalHelper(unittest.TestCase):
    def setUp(self):
        # Keep the Unix socket path below the smaller macOS path limit too.
        self.temp = tempfile.TemporaryDirectory(prefix='gpuq-pty-', dir='/tmp')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.folder = self.base / 'state' / 'terminals'
        self.folder.mkdir(parents=True)
        self.jid = str(uuid.uuid4())
        self.sock = self.folder / (self.jid + '.sock')
        source = Path(__file__).resolve().parents[1] / 'deploy' / 'terminal-helper.py'
        shutil.copy2(source, self.base / source.name)
        # This disposable subprocess must never consult a production /etc pin.
        self.guard_enable = self.base / 'guard-enable'
        guard_source = (source.parent/'platform-root-guard.py').read_text()
        (self.base/'platform-root-guard.py').write_text(guard_source.replace(
            "ENABLE=Path('/etc/gpuq-platform-root')", 'ENABLE=Path('+repr(str(self.guard_enable))+')'))
        (self.base / 'node-config.json').write_text(json.dumps({'root': str(self.base / 'state')}))
        (self.folder / (self.jid + '.json')).write_text(json.dumps({'hostAdmin': False}))
        # A raw fixture deliberately disables the kernel's echo so every ACK
        # proves that the child actually received that input, exactly once.
        (self.base / 'sandbox-runner.py').write_text(
            "import os, tty\n"
            "tty.setraw(0)\n"
            "os.write(1, b'READY\\n')\n"
            "while True:\n"
            "    data = os.read(0, 1)\n"
            "    if not data or data == b'\\x04': break\n"
            "    if data != b'~': os.write(1, data.hex().encode() + b'-')\n"
        )
        self.process = subprocess.Popen(
            [sys.executable, str(self.base / source.name), self.jid],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        self.addCleanup(self.stop)
        self.offset = 0
        deadline = time.monotonic() + 5
        received = b''
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.fail(self.process.stderr.read().decode())
            if self.sock.exists():
                received += self.exchange()[0]
                if b'READY\n' in received:
                    return
            time.sleep(0.01)
        self.fail('Local PTY fixture did not become ready')

    def stop(self):
        if self.process.poll() is None:
            try:
                self.request({'action': 'close'})
                self.process.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait(timeout=3)
        self.process.stderr.close()

    def request(self, request, allow_error=False):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(2)
            client.connect(str(self.sock))
            client.sendall((json.dumps(request) + '\n').encode())
            raw = b''
            while b'\n' not in raw:
                part = client.recv(65536)
                if not part:
                    break
                raw += part
        result = json.loads(raw)
        if not allow_error:self.assertNotIn('error', result)
        return result

    def exchange(self, data=b'', **fields):
        result = self.request({'input': base64.b64encode(data).decode(), 'offset': self.offset, **fields})
        self.offset = result['offset']
        return base64.b64decode(result['data']), result

    def test_input_echo_arrives_in_same_exchange_and_is_not_replayed(self):
        echo, result = self.exchange(b'a')
        self.assertEqual(echo, b'61-')
        self.assertFalse(result['exited'])
        for _ in range(5):
            self.assertEqual(self.exchange()[0], b'')
        self.assertEqual(self.exchange(b'b')[0], b'62-')

    def test_silent_input_is_bounded_and_empty_polls_do_not_wait(self):
        began = time.monotonic()
        self.assertEqual(self.exchange(b'~')[0], b'')
        self.assertLess(time.monotonic() - began, 0.5)
        began = time.monotonic()
        for _ in range(20):
            self.assertEqual(self.exchange()[0], b'')
        self.assertLess(time.monotonic() - began, 0.5)

    def test_offset_replay_returns_output_without_resending_input(self):
        old_offset = self.offset
        self.assertEqual(self.exchange(b'z')[0], b'7a-')
        latest = self.offset
        echo, result = self.exchange(offset=old_offset)
        self.assertEqual(echo, b'7a-')
        self.assertEqual(result['offset'], latest)
        self.assertEqual(self.exchange()[0], b'')

    def test_guard_loss_rejects_input_on_existing_connection_without_replay(self):
        self.guard_enable.mkdir(mode=0o700)
        try:
            result=self.request({'input':base64.b64encode(b'x').decode()},allow_error=True)
            self.assertIn('error',result)
        finally:self.guard_enable.rmdir()
        self.assertEqual(self.exchange()[0],b'')
        self.assertEqual(self.exchange(b'y')[0],b'79-')

    def test_buffered_paste_preserves_fifo_and_never_replays_accepted_bytes(self):
        data = b'abcdefghijklmnopqrstuvwxyz' * 100
        expected = b''.join(bytes([value]).hex().encode() + b'-' for value in data)
        received, _ = self.exchange(data)
        deadline = time.monotonic() + 3
        while len(received) < len(expected) and time.monotonic() < deadline:
            received += self.exchange()[0]
            time.sleep(0.001)
        self.assertEqual(received, expected)
        self.assertEqual(self.exchange()[0], b'')


if __name__ == '__main__':
    unittest.main()
