"""Exact private bridge literal; no keys, sockets or real SSH are used."""
import io
import json
from pathlib import Path
import runpy
from types import SimpleNamespace
import unittest
from unittest.mock import patch

WORKER = Path(__file__).resolve().parents[1]/'deploy'/'execution-worker.py'
HOST = {'id':'gpu-1','user':'fixture','address':'127.0.0.1'}


class DatasetFilesBridge(unittest.TestCase):
    def setUp(self):
        with patch.object(Path, 'read_text', return_value=json.dumps({'nodes':[HOST]})):
            self.worker = runpy.run_path(str(WORKER), run_name='dataset_files_bridge_fixture')

    def invoke(self, operation, args, result=None):
        handler = object.__new__(self.worker['Handler'])
        handler.request = SimpleNamespace(settimeout=lambda value:None)
        handler.rfile = io.BytesIO((json.dumps({'machine':HOST['id'],'operation':operation,'args':args})+'\n').encode())
        handler.wfile = io.BytesIO()
        with patch.object(self.worker['SSH_CONNECTIONS'], 'call', return_value=result or SimpleNamespace(returncode=0,stderr='',stdout='{"ok":true,"result":{"fixture":true}}')) as call:
            handler.handle()
        return json.loads(handler.wfile.getvalue()), call

    def test_exact_fixed_read_forwards_original_actor_version_directory_cursor_once(self):
        args = {'userId':'demo-user-1','hostAdmin':False,'dataset':'sample','version':'a'*64,'path':'images','cursor':'fixed-page'}
        value, call = self.invoke('datasets.files.list', args)
        self.assertTrue(value['ok']);call.assert_called_once_with(HOST, {'operation':'datasets.files.list','args':args})
        self.assertIn('datasets.files.list', self.worker['INTERNAL_STORAGE'])

    def test_nearby_arbitrary_read_write_and_host_paths_do_not_gain_new_bridge_authorization(self):
        for operation in ('datasets.files.get','datasets.files.put','datasets.files.list.extra','datasets.files','datasets.files.*'):
            with self.subTest(operation=operation):
                value, call = self.invoke(operation, {'path':'/etc/shadow'})
                self.assertFalse(value['ok']);call.assert_not_called()

    def test_lost_directory_reply_is_unconfirmed_and_never_retried(self):
        result = SimpleNamespace(returncode=255,stderr='Connection timed out PRIVATE key',stdout='')
        value, call = self.invoke('datasets.files.list', {'userId':'demo-user-1'}, result)
        self.assertFalse(value['ok']);self.assertTrue(value['outcomeUnconfirmed']);self.assertEqual(call.call_count,1)
        self.assertNotIn('PRIVATE',json.dumps(value))


if __name__ == '__main__':
    unittest.main()
