"""Local two-client PTY ownership tests; never starts a unit or connects a host."""
import base64
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid


def uid(): return str(uuid.uuid4())


class TerminalSessions(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name).resolve()
        deploy=Path(__file__).resolve().parents[1]/'deploy'
        for name in ('platform-root-guard.py','node-executor.py','scheduling-policy.py','project-ops.py','project-store.py','project-lifecycle.py'):
            shutil.copy2(deploy/name,self.base/name)
        conda=self.base/'conda'
        for name in ('bin','lib','conda-meta'):(conda/name).mkdir(parents=True)
        (conda/'bin/python').write_text('fixture only')
        (self.base/'node-config.json').write_text(json.dumps({'root':str(self.base/'state'),'hostRoot':True,'conda':str(conda)}))
        spec=importlib.util.spec_from_file_location('terminal_fixture',self.base/'node-executor.py')
        self.n=importlib.util.module_from_spec(spec);sys.modules[spec.name]=self.n;spec.loader.exec_module(self.n)
        self.context={'userId':'demo-user-1','username':'alice','hostAdmin':True}
        self.n.workspace(self.context['userId'])
        self.alive=set();self.inputs=[];self.stops=[];self.starts=[]
        def start(command):
            jid=command[-1];self.starts.append(jid);self.alive.add(jid)
            (self.n.ROOT/'terminals'/(jid+'.sock')).touch()
        self.launch=start
        def stop(jid):self.stops.append(jid);self.alive.discard(jid)
        outer=self
        class Socket:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def settimeout(self,*args):pass
            def connect(self,path):self.jid=Path(path).stem
            def sendall(self,data):outer.inputs.append((self.jid,json.loads(data)))
            def recv(self,size):return b'{"offset":0,"data":"","exited":false}\n'
        self.patches=[patch.object(self.n,'run',side_effect=start),patch.object(self.n,'stop_terminal',side_effect=stop),
                      patch.object(self.n,'terminal_alive',side_effect=lambda folder,jid:jid in self.alive),
                      patch.object(self.n.socket,'socket',side_effect=lambda *a:Socket())]
        for item in self.patches:item.start()

    def tearDown(self):
        for item in reversed(self.patches):item.stop()
        self.temp.cleanup()

    def open(self,context=None,**fields):
        request={**(context or self.context),'mode':'new','key':uid(),'clientId':uid(),**fields}
        return request,self.n.process('terminal.open',request)

    def connection(self,request,result):
        return {**{k:request[k] for k in ('userId','username','hostAdmin','project') if k in request},
                'id':result['id'],'clientId':request['clientId'],'writerToken':result['writerToken']}

    def reconnect(self,connection,**fields):
        request={**connection,'mode':'reconnect','key':uid(),**fields}
        return request,self.n.process('terminal.open',request)

    def test_two_same_account_clients_get_independent_root_sessions_and_close_is_local(self):
        a,ar=self.open();b,br=self.open();ca,cb=self.connection(a,ar),self.connection(b,br)
        self.assertNotEqual(ar['id'],br['id'])
        for conn,text in ((ca,b'first'),(cb,b'second')):
            self.n.process('terminal.exchange',{**conn,'input':base64.b64encode(text).decode()})
        self.assertEqual([item[0] for item in self.inputs],[ar['id'],br['id']])
        self.n.process('terminal.close',cb)
        self.assertEqual(self.stops,[br['id']]);self.assertIn(ar['id'],self.alive)
        self.n.process('terminal.exchange',ca)

    def test_simultaneous_same_account_new_requests_never_alias_sessions(self):
        gate=threading.Barrier(2);results=[];errors=[]
        def start(command):
            gate.wait(timeout=2)
            self.launch(command)
        def open_client():
            try:results.append(self.open())
            except BaseException as error:errors.append(error)
        with patch.object(self.n,'run',side_effect=start):
            workers=[threading.Thread(target=open_client) for _ in range(2)]
            for worker in workers:worker.start()
            for worker in workers:worker.join(3)
        self.assertTrue(all(not worker.is_alive() for worker in workers));self.assertEqual(errors,[])
        self.assertEqual(len(results),2);self.assertEqual(len({result['id'] for _,result in results}),2)
        self.assertEqual(len(self.n.terminal_pointers(self.context)),2)

    def test_active_writer_reconnect_requires_explicit_takeover_and_fences_old_close(self):
        request,result=self.open();old=self.connection(request,result)
        other={**old,'clientId':uid()};other.pop('writerToken')
        with self.assertRaisesRegex(ValueError,'active writer'):self.reconnect(other)
        attach,new=self.reconnect(other,takeover=True);current=self.connection(attach,new)
        self.assertEqual(result['id'],new['id']);self.assertNotEqual(result['writerToken'],new['writerToken'])
        for operation in ('terminal.exchange','terminal.close','terminal.detach'):
            with self.assertRaisesRegex(ValueError,'lease'):self.n.process(operation,old)
        self.assertEqual(self.stops,[])
        self.n.process('terminal.exchange',current)

    def test_lease_expiry_never_stops_pty_and_old_token_cannot_close(self):
        request,result=self.open();old=self.connection(request,result)
        with patch.object(self.n.time,'time',return_value=result['leaseExpiresAt']+1):
            for operation in ('terminal.exchange','terminal.close'):
                with self.assertRaisesRegex(ValueError,'expired'):self.n.process(operation,old)
            with self.assertRaisesRegex(ValueError,'reconnect explicitly'):self.n.process('terminal.open',request)
            attach,new=self.reconnect({**old,'clientId':uid()})
            self.n.process('terminal.exchange',self.connection(attach,new))
        self.assertEqual(self.stops,[]);self.assertEqual(self.starts,[result['id']])

    def test_detach_releases_writer_without_stopping_and_reconnect_rotates_token(self):
        request,result=self.open();old=self.connection(request,result)
        self.assertTrue(self.n.process('terminal.detach',old)['detached'])
        self.assertEqual(self.stops,[])
        attach,new=self.reconnect({**old,'clientId':uid()})
        self.assertEqual(new['id'],result['id'])
        with self.assertRaises(ValueError):self.n.process('terminal.close',old)
        self.n.process('terminal.close',self.connection(attach,new))

    def test_new_and_reconnect_keys_are_idempotent_without_relaunch_or_token_churn(self):
        request,result=self.open()
        self.assertEqual(self.n.process('terminal.open',request)['writerToken'],result['writerToken'])
        attach,new=self.reconnect(self.connection(request,result))
        self.assertEqual(self.n.process('terminal.open',attach)['writerToken'],new['writerToken'])
        self.assertEqual(self.starts,[result['id']])

    def test_legacy_session_is_not_silently_reused_or_stopped_and_requires_takeover(self):
        self.n.workspace(self.context['userId']);folder=self.n.ROOT/'terminals';folder.mkdir()
        old=uid();(folder/(old+'.json')).write_text(json.dumps(self.context))
        pointer=self.n.terminal_pointer(self.context);pointer.write_text(old);self.alive.add(old)
        request,new=self.open();self.assertNotEqual(new['id'],old)
        self.assertEqual(pointer.read_text(),old);self.assertEqual(self.stops,[])
        old_context={**self.context,'id':old,'clientId':uid()}
        with self.assertRaisesRegex(ValueError,'Legacy'):self.reconnect(old_context)
        attach,taken=self.reconnect(old_context,takeover=True)
        self.n.process('terminal.exchange',self.connection(attach,taken))
        self.assertEqual(self.stops,[])

    def test_cross_account_context_and_key_collision_are_rejected_even_with_writer_token(self):
        request,result=self.open();own=self.connection(request,result)
        for changes in ({'userId':'demo-user-2'},{'hostAdmin':False},{'project':'other','hostAdmin':False}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):
                self.n.terminal_op('terminal.close',{**own,**changes})
        with self.assertRaisesRegex(ValueError,'not owned'):
            self.open({**self.context,'userId':'demo-user-2'},key=result['id'])
        self.assertEqual(self.stops,[]);self.assertEqual(self.starts,[result['id']])

    def test_legacy_client_missing_lease_is_rejected_without_mutation(self):
        with self.assertRaisesRegex(ValueError,'upgrade'):
            self.n.process('terminal.open',{**self.context,'key':uid()})
        self.assertEqual(self.starts,[]);self.assertEqual(self.stops,[])

    def test_project_publication_sees_all_independent_session_fences(self):
        context={**self.context,'hostAdmin':False,'project':'test'}
        self.n.process('projects.create',{'userId':context['userId'],'project':'test'})
        a,ar=self.open(context);b,br=self.open(context)
        self.assertEqual(len(self.n.terminal_pointers(context)),2)
        with patch.object(self.n.projects(),'terminal_stopped',return_value=True):
            self.n.process('terminal.close',self.connection(a,ar))
        with self.assertRaisesRegex(ValueError,'Close'):
            self.n.process('projects.publish',{'userId':context['userId'],'project':'test'})
        self.assertIn(br['id'],self.alive)

    def test_new_key_does_not_replace_a_dead_or_unknown_existing_key(self):
        request,result=self.open();self.alive.clear()
        with self.assertRaisesRegex(ValueError,'not reachable'):self.n.process('terminal.open',request)
        self.assertEqual(self.starts,[result['id']]);self.assertEqual(self.stops,[])


if __name__=='__main__':unittest.main()
