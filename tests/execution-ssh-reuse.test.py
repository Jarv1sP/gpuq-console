"""Synthetic sockets and a fake OpenSSH process; never touch keys or real nodes."""
from concurrent.futures import ThreadPoolExecutor
import json
import io
from pathlib import Path
import runpy
import socket
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

WORKER=Path(__file__).resolve().parents[1]/'deploy/execution-worker.py'
HOST={'id':'gpu-4','user':'fixture','address':'127.0.0.1'}

class FakeSSH:
    def __init__(self):
        self.guard=threading.Lock();self.sockets={};self.live=set();self.started=[];self.requests=[]
        self.active=0;self.peak=0;self.fail_rpc=False;self.timeout_rpc=False;self.check_error=None
        self.fail_master=False;self.timeout_master=False
    def run(self, command, **kw):
        path=Path(next(s.split('=',1)[1] for s in command if s.startswith('ControlPath=')))
        if '-O' in command:
            with self.guard:live=path in self.live
            return SimpleNamespace(returncode=0 if live else 255,stdout=b'',stderr=self.check_error or (b'' if live else b'Control socket connect: Connection refused'))
        if 'ControlPersist=15s' in command:
            if self.timeout_master:
                self.started.append((command,kw));raise subprocess.TimeoutExpired(command,kw['timeout'])
            if self.fail_master:
                self.started.append((command,kw));return SimpleNamespace(returncode=255,stdout=b'',stderr=b'Fixture authentication denied')
            with self.guard:
                self.started.append((command,kw));sock=socket.socket(socket.AF_UNIX);sock.bind(str(path));path.chmod(0o600)
                self.sockets[path]=sock
            time.sleep(.015)
            with self.guard:self.live.add(path)
            return SimpleNamespace(returncode=0,stdout=b'',stderr=b'')
        with self.guard:
            self.requests.append((command,kw));self.active+=1;self.peak=max(self.peak,self.active)
        try:
            time.sleep(.015)
            if self.timeout_rpc:raise subprocess.TimeoutExpired(command,kw['timeout'])
            return SimpleNamespace(returncode=255 if self.fail_rpc else 0,stdout='{"ok":true}',stderr='')
        finally:
            with self.guard:self.active-=1
    def close(self):
        for sock in self.sockets.values():sock.close()

class ConnectionReuse(unittest.TestCase):
    def setUp(self):
        inventory=json.dumps({'nodes':[HOST]})
        with patch.object(Path,'read_text',return_value=inventory):self.worker=runpy.run_path(str(WORKER),run_name='reuse_test')
        self.temp=tempfile.TemporaryDirectory(prefix='ssh-',dir='/tmp')
        self.runtime=Path(self.temp.name);self.runtime.chmod(0o700)
        self.connections=self.worker['SSHConnections'](base=Path('/fixture/executor'),runtime=self.runtime)
        self.fake=FakeSSH();self.run_patch=patch.object(self.worker['subprocess'],'run',side_effect=self.fake.run);self.run_patch.start()
    def tearDown(self):
        self.run_patch.stop();self.fake.close();self.temp.cleanup()
    def call(self,i=0,host=HOST):return self.connections.call(host,{'operation':'terminal.exchange','args':{'id':'fixed','input':str(i)}})
    def test_reuses_master_and_keeps_key_pin_forced_command_and_input(self):
        self.call(1);self.call(2)
        self.assertEqual(len(self.fake.started),1);self.assertEqual(len(self.fake.requests),2)
        start,kw=self.fake.started[0]
        self.assertIn('-N',start);self.assertIn('-f',start);self.assertNotIn('input',kw)
        # -M after explicit ControlMaster=yes toggles OpenSSH into ask mode.
        self.assertNotIn('-M',start);self.assertIn('ControlMaster=yes',start)
        self.assertNotIn('ProxyCommand=/usr/bin/false',start)
        self.assertEqual(kw['stdin'],subprocess.DEVNULL);self.assertIn('ControlPersist=15s',start)
        for command,request in self.fake.requests:
            self.assertEqual(command[-1],'fixture@127.0.0.1')
            self.assertIn('StrictHostKeyChecking=yes',command);self.assertIn('UserKnownHostsFile=/fixture/executor/known_hosts',command)
            self.assertIn('IdentitiesOnly=yes',command);self.assertIn('ControlMaster=no',command)
            self.assertIn('ForwardAgent=no',command);self.assertIn('ForwardX11=no',command);self.assertIn('ClearAllForwardings=yes',command)
            self.assertIn('ProxyCommand=/usr/bin/false',command)
            self.assertNotIn('shell',request);self.assertEqual(json.loads(request['input'])['operation'],'terminal.exchange')
            self.assertGreater(request['timeout'],0);self.assertLessEqual(request['timeout'],27)
        self.assertEqual((self.runtime/'ssh-mux').stat().st_mode&0o777,0o700)
    def test_concurrent_cold_requests_start_one_master_without_serializing_rpcs(self):
        with ThreadPoolExecutor(max_workers=12) as pool:results=list(pool.map(self.call,range(12)))
        self.assertTrue(all(x.returncode==0 for x in results));self.assertEqual(len(self.fake.started),1)
        self.assertEqual(len(self.fake.requests),12);self.assertGreaterEqual(self.fake.peak,2);self.assertLessEqual(self.fake.peak,8)
        self.assertEqual(sorted(json.loads(k['input'])['args']['input'] for _,k in self.fake.requests),sorted(map(str,range(12))))
    def test_hosts_do_not_share_control_paths(self):
        self.call();self.call(host={**HOST,'address':'127.0.0.2'})
        self.assertEqual(len(self.fake.started),2);self.assertEqual(len(self.fake.sockets),2)
    def test_failed_rpc_is_not_retried(self):
        self.fake.fail_rpc=True;result=self.call()
        self.assertEqual(result.returncode,255);self.assertEqual(len(self.fake.requests),1)
    def test_refused_warm_channel_cannot_fallback_or_replay(self):
        self.call('first');self.fake.fail_rpc=True;result=self.call('second')
        self.assertEqual(result.returncode,255);self.assertEqual(len(self.fake.started),1)
        self.assertEqual([json.loads(k['input'])['args']['input'] for _,k in self.fake.requests],['first','second'])
        self.assertIn('ProxyCommand=/usr/bin/false',self.fake.requests[-1][0])
    def test_timed_out_rpc_is_not_retried_or_leaked(self):
        self.fake.timeout_rpc=True
        with self.assertRaisesRegex(ValueError,'^Node connection failed$'):self.call()
        self.assertEqual(len(self.fake.requests),1)
    def test_rpc_timeout_has_fixed_safe_classification_without_stderr(self):
        self.fake.timeout_rpc=True
        with self.assertRaises(self.worker['NodeTransportError']) as caught:self.call()
        self.assertEqual(caught.exception.code,'NODE_RESPONSE_TIMEOUT');self.assertEqual(caught.exception.status,504)
        self.assertEqual(str(caught.exception),'Node connection failed');self.assertEqual(len(self.fake.requests),1)
    def test_ssh_auth_host_key_and_connection_errors_are_classified_without_private_details(self):
        classify=self.worker['ssh_transport_failure']
        for message,code,status in [(b'Permission denied PRIVATE secret','NODE_SSH_AUTH_FAILED',502),
                (b'Host key verification failed PRIVATE path','NODE_SSH_HOSTKEY_FAILED',502),
                (b'Connection timed out PRIVATE address','NODE_CONNECT_FAILED',503)]:
            error=classify(SimpleNamespace(stderr=message),'master')
            self.assertEqual((error.code,error.status,error.phase),(code,status,'master'))
            self.assertNotIn('PRIVATE',str(error))
    def handler_response(self,completed=None,error=None):
        handler=object.__new__(self.worker['Handler'])
        handler.request=SimpleNamespace(settimeout=lambda value:None)
        handler.rfile=io.BytesIO((json.dumps({'machine':'gpu-4','operation':'host.status','args':{}})+'\n').encode())
        handler.wfile=io.BytesIO()
        with patch.object(self.worker['SSH_CONNECTIONS'],'call',return_value=completed,side_effect=error):handler.handle()
        return json.loads(handler.wfile.getvalue())
    def test_handler_emits_fixed_transport_envelope_but_does_not_promote_native_denials(self):
        reply=self.handler_response(SimpleNamespace(returncode=255,stderr='Permission denied PRIVATE token',stdout=''))
        self.assertEqual((reply['status'],reply['code'],reply['phase']),(502,'NODE_SSH_AUTH_FAILED','rpc'))
        self.assertTrue(reply['outcomeUnconfirmed']);self.assertNotIn('PRIVATE',json.dumps(reply))
        reply=self.handler_response(SimpleNamespace(returncode=0,stderr='',stdout='PRIVATE malformed'))
        self.assertEqual((reply['status'],reply['code']),(502,'NODE_RESPONSE_INVALID'));self.assertNotIn('PRIVATE',json.dumps(reply))
        reply=self.handler_response(SimpleNamespace(returncode=0,stderr='',stdout='{"ok":false,"error":"Native owner refusal"}'))
        self.assertEqual(reply,{'ok':False,'error':'Native owner refusal'})
    def test_handler_timeout_keeps_unconfirmed_outcome_and_never_sends_a_second_rpc(self):
        error=self.worker['NodeTransportError']('NODE_RESPONSE_TIMEOUT',504,'rpc')
        handler=object.__new__(self.worker['Handler']);handler.request=SimpleNamespace(settimeout=lambda value:None)
        handler.rfile=io.BytesIO((json.dumps({'machine':'gpu-4','operation':'host.exec','args':{'key':'fixed'}})+'\n').encode());handler.wfile=io.BytesIO()
        with patch.object(self.worker['SSH_CONNECTIONS'],'call',side_effect=error) as call:handler.handle()
        reply=json.loads(handler.wfile.getvalue());self.assertEqual(call.call_count,1)
        self.assertEqual((reply['status'],reply['code']),(504,'NODE_RESPONSE_TIMEOUT'));self.assertTrue(reply['outcomeUnconfirmed'])
    def test_failed_or_timed_out_handshake_does_not_send_input(self):
        for mode in ('fail_master','timeout_master'):
            setattr(self.fake,mode,True)
            with self.assertRaisesRegex(ValueError,'^Node connection failed$'):self.call(mode)
            setattr(self.fake,mode,False)
        self.assertEqual(len(self.fake.started),2);self.assertEqual(len(self.fake.requests),0)
    def test_new_request_after_channel_timeout_never_replays_old_input(self):
        self.fake.timeout_rpc=True
        with self.assertRaisesRegex(ValueError,'^Node connection failed$'):self.call('old')
        self.fake.timeout_rpc=False;self.call('new')
        self.assertEqual(len(self.fake.started),1)
        self.assertEqual([json.loads(k['input'])['args']['input'] for _,k in self.fake.requests],['old','new'])
    def test_stale_private_socket_recreated_once_without_replaying_input(self):
        self.call(1);path=next(iter(self.fake.live));self.fake.live.remove(path);self.fake.sockets[path].close()
        self.call(2);self.assertEqual(len(self.fake.started),2);self.assertEqual(len(self.fake.requests),2)
    def test_unrecognized_master_error_does_not_unlink_or_send_input(self):
        self.call();path=next(iter(self.fake.live));self.fake.live.clear();self.fake.check_error=b'Permission denied'
        before=path.stat().st_ino
        with self.assertRaisesRegex(ValueError,'Node connection failed'):self.call(2)
        self.assertEqual(path.stat().st_ino,before);self.assertEqual(len(self.fake.requests),1)
    def test_private_directory_symlink_rejected_without_ssh(self):
        (self.runtime/'ssh-mux').symlink_to(self.runtime,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'Node connection failed'):self.call()
        self.assertFalse(self.fake.requests);self.assertFalse(self.fake.started)
    def test_regular_file_at_socket_path_is_not_unlinked(self):
        name,*_=self.connections.identity(HOST);path=self.connections.control_path(name);path.write_text('owned fixture');path.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'Unsafe SSH control socket'):self.call()
        self.assertEqual(path.read_text(),'owned fixture');self.assertFalse(self.fake.started)
    def test_socket_symlink_is_not_followed(self):
        name,*_=self.connections.identity(HOST);path=self.connections.control_path(name);path.symlink_to(self.runtime/'missing')
        with self.assertRaisesRegex(ValueError,'Unsafe SSH control socket'):self.call()
        self.assertTrue(path.is_symlink());self.assertFalse(self.fake.started)
    def test_group_writable_runtime_or_private_dir_rejected(self):
        self.runtime.chmod(0o770)
        with self.assertRaisesRegex(ValueError,'Unsafe SSH runtime directory'):self.call()
        self.runtime.chmod(0o700);(self.runtime/'ssh-mux').mkdir(mode=0o750)
        with self.assertRaisesRegex(ValueError,'Unsafe SSH control directory'):self.call()
        self.assertFalse(self.fake.started)
    def test_host_option_injection_or_nonliteral_address_rejected(self):
        for host in ({**HOST,'user':'-oProxyCommand=bad'},{**HOST,'address':'example.invalid'},{**HOST,'address':'127.0.0.1 -p 9'}):
            with self.assertRaisesRegex(ValueError,'Invalid fixed host'):self.call(host=host)
        self.assertFalse(self.fake.started);self.assertFalse(self.fake.requests)
    def test_expired_budget_does_not_dispatch_rpc(self):
        # Master startup may finish, but no input is sent after the original budget.
        self.call();
        with patch.object(self.worker['time'],'monotonic',side_effect=[0,28,28,28,28]):
            with self.assertRaisesRegex(ValueError,'Node connection failed'):self.call(2)
        self.assertEqual(len(self.fake.requests),1)

if __name__=='__main__':unittest.main()
