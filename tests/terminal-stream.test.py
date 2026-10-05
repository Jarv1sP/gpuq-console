"""Local pipes and synthetic terminal fences; no keys, GPU or real SSH."""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
PROTOCOL='terminal-exchange-stream-v1'
def context():return {'userId':'demo-user-1','username':'alice','id':str(uuid4()),'clientId':str(uuid4()),'writerToken':str(uuid4())}
def frame(ctx,seq=0,**args):return (json.dumps({'sequence':seq,'args':{**ctx,**args}})+'\n').encode()

class Lines:
    def __init__(self,lines):self.lines=iter(lines)
    def line(self,limit,deadline):
        raw=next(self.lines,b'')
        if len(raw)>limit:raise ValueError('Terminal frame too large')
        return raw

class NodeStreams(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.path=Path(self.tmp.name)
        for name in ('node-executor.py','scheduling-policy.py'):shutil.copy2(ROOT/'deploy'/name,self.path/name)
        (self.path/'node-config.json').write_text(json.dumps({'root':str(self.path/'root'),'hostRoot':False}))
        spec=importlib.util.spec_from_file_location('terminal_stream_node',self.path/'node-executor.py')
        self.node=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.node)
        self.ctx=context();self.folder=self.node.ROOT/'terminals';self.folder.mkdir(parents=True)
        (self.folder/(self.ctx['id']+'.json')).write_text(json.dumps({'userId':self.ctx['userId']}))
        self.receipt={'clientId':self.ctx['clientId'],'writerToken':self.ctx['writerToken'],'leaseExpiresAt':time.time()+30,'state':'OPEN'}
        self.write_receipt();self.inputs=[];self.output=[]
        def process(operation,args):
            self.assertEqual(operation,'terminal.exchange');self.node.platform_root_check()
            self.node.terminal_stream_context({key:value for key,value in args.items() if key in self.node.TERMINAL_CONTEXT_FIELDS})
            self.inputs.append(args.get('input'));return {'data':'','offset':len(self.inputs)}
        self.guard=Mock();self.addCleanup(patch.stopall)
        patch.object(self.node,'platform_root_check',self.guard).start();patch.object(self.node,'process',side_effect=process).start()
    def write_receipt(self): (self.folder/(self.ctx['id']+'.session.json')).write_text(json.dumps(self.receipt))
    def run_stream(self,lines,write=None,header=None):
        self.node.serve_terminal_stream(header or {'protocol':PROTOCOL,'context':self.ctx},Lines(lines),write or self.output.append)
    def test_handshake_then_fifo_exchange_rechecks_guard_and_writer(self):
        self.run_stream([frame(self.ctx,0,input='a'),frame(self.ctx,1,input='b')])
        self.assertEqual(self.output[0],{'protocol':PROTOCOL,'ready':True});self.assertEqual(self.inputs,['a','b'])
        self.assertEqual([x['sequence'] for x in self.output[1:]],[0,1]);self.assertEqual(self.guard.call_count,3)
    def test_invalid_handshake_has_no_input_or_ack(self):
        for changed in ({'writerToken':str(uuid4())},{'userId':'demo-user-2'},{'hostAdmin':True},{'username':'-oBad'}):
            with self.assertRaises(ValueError):self.run_stream([],header={'protocol':PROTOCOL,'context':{**self.ctx,**changed}})
        self.assertEqual(self.output,[]);self.assertEqual(self.inputs,[])
    def test_context_sequence_and_nonexchange_operation_are_rejected_before_input(self):
        samples=[frame({**self.ctx,'writerToken':str(uuid4())}),frame(self.ctx,1),
                 (json.dumps({'sequence':0,'args':{**self.ctx,'operation':'terminal.close'}})+'\n').encode()]
        for raw in samples:
            with self.assertRaises(ValueError):self.run_stream([raw])
        self.assertFalse(self.inputs)
    def test_writer_takeover_after_ack_is_not_cached(self):
        def write(value):
            self.output.append(value)
            if value.get('sequence')==0:self.receipt['writerToken']=str(uuid4());self.write_receipt()
        self.run_stream([frame(self.ctx,0,input='a'),frame(self.ctx,1,input='b')],write)
        self.assertEqual(self.inputs,['a']);self.assertFalse(self.output[-1]['ok'])
    def test_closed_or_expired_writer_cannot_get_ready_ack(self):
        for change in ({'state':'CLOSED'},{'leaseExpiresAt':0}):
            self.receipt.update(change);self.write_receipt()
            with self.assertRaises(ValueError):self.run_stream([])
        self.assertFalse(self.inputs);self.assertFalse(self.output)
    def test_configuration_or_closure_change_invalidates_old_stream(self):
        for role in ('config','closure'):
            self.output=[];self.inputs=[]
            def write(value):
                self.output.append(value)
                if value.get('sequence')==0:
                    target=self.path/('node-config.json' if role=='config' else 'new-module.py');target.write_text('{}')
            with self.assertRaisesRegex(ValueError,'runtime changed'):self.run_stream([frame(self.ctx,0,input='a'),frame(self.ctx,1,input='b')],write)
            self.assertEqual(self.inputs,['a'])
            (self.path/'node-config.json').write_bytes(self.node.INITIAL_CONFIG_BYTES)
            (self.path/'new-module.py').unlink(missing_ok=True)
    def test_frame_limit_partial_frame_and_boolean_sequence_reject(self):
        for raw in (frame(self.ctx,input='a'*32768),frame(self.ctx)[:-1],frame(self.ctx,False)):
            with self.assertRaises(ValueError):self.run_stream([raw])
        self.assertFalse(self.inputs)
    def test_prefetched_lines_and_legacy_pretty_json_remain_bounded(self):
        r,w=os.pipe();self.addCleanup(os.close,r);os.write(w,b'first\nsecond\n');os.close(w)
        reader=self.node.BoundedRPCInput(r)
        self.assertEqual(reader.line(32,time.monotonic()+1),b'first\n');self.assertEqual(reader.line(32,time.monotonic()+1),b'second\n');self.assertEqual(reader.line(32,time.monotonic()+1),b'')
        r,w=os.pipe();self.addCleanup(os.close,r);os.write(w,b'{\n "operation": "old"\n}');os.close(w)
        reader=self.node.BoundedRPCInput(r);first=reader.line(1024,time.monotonic()+1)
        self.assertEqual(json.loads(reader.rest(first,1024)),{'operation':'old'})
    def test_output_frame_is_bounded(self):
        out=SimpleNamespace(buffer=io.BytesIO())
        with patch.object(self.node.sys,'stdout',out):
            self.node.write_rpc_line({'ok':True});self.assertEqual(json.loads(out.buffer.getvalue()),{'ok':True})
            with self.assertRaisesRegex(ValueError,'response too large'):self.node.write_rpc_line({'data':'x'*1048576})
    def test_expired_deadline_rejects_prefetched_frame(self):
        r,w=os.pipe();self.addCleanup(os.close,r);os.write(w,b'first\nsecond\n');os.close(w)
        reader=self.node.BoundedRPCInput(r)
        self.assertEqual(reader.line(32,time.monotonic()+1),b'first\n')
        with self.assertRaisesRegex(TimeoutError,'expired'):reader.line(32,time.monotonic()-1)
        self.assertEqual(reader.pending,b'second\n')

SERVER='''
import json,sys
h=json.loads(sys.stdin.readline())
if MODE=='bad-ack':print(json.dumps({'ready':False}),flush=True);sys.exit()
print(json.dumps({'protocol':'terminal-exchange-stream-v1','ready':True}),flush=True)
for line in sys.stdin:
 x=json.loads(line)
 if MODE=='lost-response':sys.exit()
 result={'sequence':x['sequence']+(1 if MODE=='bad-sequence' else 0),'ok':True,'result':{'input':x['args'].get('input'),'pid':__import__('os').getpid()}}
 print(json.dumps(result),flush=True)
'''
class FakeConnection:
    def __init__(self):self.slots=threading.BoundedSemaphore(8);self.lock=threading.Lock();self.starts=0;self.mode='ok';self.master_fail=False
    def identity(self,host):return host['address'],'fixture@127.0.0.1',self.lock,self.slots
    def control_path(self,name):return Path('/fixture/private/control')
    def ensure_master(self,*args):
        if self.master_fail:raise ValueError('Node connection failed')
    def rpc_command(self,*args):
        self.starts+=1;return [sys.executable,'-u','-c','MODE='+repr(self.mode)+'\n'+SERVER]

class BridgeStreams(unittest.TestCase):
    def setUp(self):
        with patch.object(Path,'read_text',return_value=json.dumps({'nodes':[]})):
            self.worker=runpy.run_path(str(ROOT/'deploy/execution-worker.py'),run_name='terminal_stream_bridge')
        self.conn=FakeConnection();self.pool=self.worker['TerminalChannels'](self.conn);self.ctx=context();self.host={'user':'fixture','address':'127.0.0.1'}
        self.addCleanup(self.cleanup)
    def cleanup(self):
        with self.pool.guard:
            for c in self.pool.channels.values():c.retire_if_idle(time.monotonic(),force=True)
    def call(self,input='a',ctx=None):return self.pool.call(self.host,{**(ctx or self.ctx),'input':input})
    def test_reuses_one_process_only_after_ready_ack(self):
        a=self.call('a');b=self.call('b');self.assertEqual(a['result']['pid'],b['result']['pid']);self.assertEqual(self.conn.starts,1)
        self.assertEqual([a['result']['input'],b['result']['input']],['a','b'])
    def test_different_writer_and_session_do_not_share_channel(self):
        a=self.call();b=self.call(ctx={**self.ctx,'writerToken':str(uuid4())});self.assertNotEqual(a['result']['pid'],b['result']['pid']);self.assertEqual(self.conn.starts,2)
    def test_handshake_or_master_failure_sends_zero_input_frames(self):
        sent=[];original=self.worker['TerminalChannel'].send
        def observe(c,value,deadline):sent.append(value);return original(c,value,deadline)
        with patch.object(self.worker['TerminalChannel'],'send',observe):
            self.conn.master_fail=True
            with self.assertRaises(ValueError):self.call('never')
            self.assertEqual(sent,[]);self.conn.master_fail=False;self.conn.mode='bad-ack'
            with self.assertRaisesRegex(ValueError,'handshake'):self.call('never')
            self.assertTrue(sent);self.assertTrue(all('sequence' not in x for x in sent))
    def test_lost_or_mismatched_response_never_replays_input(self):
        for mode in ('lost-response','bad-sequence'):
            self.conn.mode=mode;sent=[];original=self.worker['TerminalChannel'].send
            def observe(c,value,deadline):sent.append(value);return original(c,value,deadline)
            with patch.object(self.worker['TerminalChannel'],'send',observe):
                with self.assertRaises(ValueError):self.call('old')
            self.assertEqual([x['args']['input'] for x in sent if 'sequence' in x],['old'])
        self.conn.mode='ok';self.assertEqual(self.call('new')['result']['input'],'new')
    def test_per_context_fifo_reservations(self):
        channel=self.worker['TerminalChannel'](self.conn,self.host,self.ctx)
        tickets=[channel.reserve() for _ in range(4)]
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures=[pool.submit(channel.exchange,t,{**self.ctx,'input':str(i)},time.monotonic()+10) for i,t in reversed(list(enumerate(tickets)))]
            results=[f.result() for f in futures]
        self.assertEqual(channel.sequence,4);self.assertEqual(sorted(x['result']['input'] for x in results),['0','1','2','3']);channel.close()
    def test_idle_and_ttl_rotate_before_new_input(self):
        a=self.call();channel=next(iter(self.pool.channels.values()));channel.created-=56
        b=self.call('next');self.assertNotEqual(a['result']['pid'],b['result']['pid']);self.assertEqual(self.conn.starts,2)
    def test_cap_bounded_context_and_input(self):
        with self.assertRaisesRegex(ValueError,'frame too large'):self.call('x'*32768)
        for bad in ({**self.ctx,'id':'bad'},{**self.ctx,'project':'x'*5000}):
            with self.assertRaisesRegex(ValueError,'context'):self.call(ctx=bad)
        for _ in range(8):self.call(ctx=context())
        self.assertLessEqual(len(self.pool.channels),6)
        self.assertTrue(all(self.conn.slots.acquire(False) for _ in range(2)))
        self.assertFalse(self.conn.slots.acquire(False));self.conn.slots.release();self.conn.slots.release()
    def test_expired_response_deadline_rejects_prefetched_frame(self):
        channel=self.worker['TerminalChannel'](self.conn,self.host,self.ctx)
        channel.pending.extend(b'{"ok":true}\n')
        with self.assertRaisesRegex(ValueError,'unconfirmed'):channel.line(32,time.monotonic()-1)
        self.assertEqual(channel.pending,b'{"ok":true}\n')
    def test_only_unsent_new_context_capacity_can_use_one_legacy_rpc(self):
        function=self.worker['terminal_exchange'];args={**self.ctx,'machine':'amax-3090','input':'a'}
        legacy=Mock(return_value=SimpleNamespace(returncode=0,stdout='{"ok":true,"result":{}}'))
        pool=Mock();pool.call.side_effect=self.worker['TerminalCapacity']('capacity')
        with patch.dict(function.__globals__,TERMINAL_CHANNELS=pool,SSH_CONNECTIONS=SimpleNamespace(call=legacy)):
            self.assertTrue(function(self.host,args,'amax-3090')['ok'])
            legacy.assert_called_once_with(self.host,{'operation':'terminal.exchange','args':args})
            legacy.reset_mock();pool.call.side_effect=ValueError('Terminal exchange unconfirmed')
            with self.assertRaisesRegex(ValueError,'unconfirmed'):function(self.host,args,'amax-3090')
            legacy.assert_not_called()
        for _ in range(6):self.call(ctx=context())
        with self.pool.guard:
            for channel in self.pool.channels.values():channel.active=True
        before=self.conn.starts
        try:
            with self.assertRaises(self.worker['TerminalCapacity']):self.call(ctx=context())
            self.assertEqual(self.conn.starts,before)
        finally:
            with self.pool.guard:
                for channel in self.pool.channels.values():channel.active=False
    def test_actual_execution_envelope_strips_only_equal_authorized_machine(self):
        function=self.worker['terminal_exchange'];args={**self.ctx,'machine':'amax-3090','hostAdmin':False,'input':'YQ==','offset':0,'rows':32,'cols':110}
        with patch.dict(function.__globals__,TERMINAL_CHANNELS=self.pool):
            self.assertEqual(function(self.host,args,'amax-3090')['result']['input'],'YQ==')
            before=self.conn.starts
            with self.assertRaisesRegex(ValueError,'machine context'):function(self.host,args,'amax-5090')
            with self.assertRaisesRegex(ValueError,'stream fields'):function(self.host,{**args,'unexpected':True},'amax-3090')
            self.assertEqual(self.conn.starts,before)

if __name__=='__main__':unittest.main()
