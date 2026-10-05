"""Bounded bubblewrap startup stream parsing; no sandbox, GPU or network."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import patch

DEPLOY=Path(__file__).resolve().parents[1]/'deploy'
RUNNERS=[]
for name in ('sandbox-runner.py','sandbox-runner-common-p0.py'):
    spec=importlib.util.spec_from_file_location(name,DEPLOY/name)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    RUNNERS.append(module)


class SandboxInformation(unittest.TestCase):
    def read(self,runner,raw):
        reader,writer=os.pipe();os.write(writer,raw);os.close(writer)
        try:return runner.sandbox_information(reader,timeout=.2)
        finally:
            with self.assertRaises(OSError):os.fstat(reader)

    def test_complete_namespace_record_and_maximum_size(self):
        raw=json.dumps({'child-pid':12345,'mnt-namespace':40265355}).encode()
        for runner in RUNNERS:
            with self.subTest(runner=runner.__name__):
                self.assertEqual(self.read(runner,raw)['child-pid'],12345)
                self.assertEqual(self.read(runner,raw+b' '*(4096-len(raw)))['child-pid'],12345)
                with self.assertRaisesRegex(ValueError,'exceeds limit'):self.read(runner,raw+b' '*4096)

    def test_empty_truncated_malformed_or_wrong_pid_fails_closed(self):
        cases=[b'',b'{"child-pid":123',b'{"child-pid":123}\n{}',b'\xff',b'[]',b'null',b'{}',
               b'{"child-pid":true}',b'{"child-pid":"123"}',b'{"child-pid":0}',b'{"child-pid":-2}',b'{"child-pid":2147483648}']
        for runner in RUNNERS:
            for raw in cases:
                with self.subTest(runner=runner.__name__,raw=raw),self.assertRaises(ValueError):self.read(runner,raw)

    def test_stalled_or_complete_but_unclosed_writer_has_bounded_deadline(self):
        for runner in RUNNERS:
            for raw in (b'',b'{"child-pid":123}',b'{"child-pid":'):
                reader,writer=os.pipe()
                try:
                    os.write(writer,raw);start=time.monotonic()
                    with self.assertRaisesRegex(RuntimeError,'timed out'):runner.sandbox_information(reader,timeout=.025)
                    self.assertLess(time.monotonic()-start,.5)
                    with self.assertRaises(OSError):os.fstat(reader)
                finally:os.close(writer)

    def test_each_fragment_does_not_reset_total_deadline(self):
        for runner in RUNNERS:
            reader,writer=os.pipe()
            try:
                os.write(writer,b'{')
                with patch.object(runner.time,'monotonic',side_effect=[0,.01,.11]):
                    with self.assertRaisesRegex(RuntimeError,'timed out'):runner.sandbox_information(reader,timeout=.1)
                with self.assertRaises(OSError):os.fstat(reader)
            finally:os.close(writer)

    def test_fragmented_independent_concurrent_streams_do_not_mix_jobs(self):
        for runner in RUNNERS:
            reports=[];threads=[]
            def one(pid):
                reader,writer=os.pipe()
                def produce():
                    try:
                        for part in (b'{\n"child-pid":',str(pid).encode(),b',\n"mnt-namespace":42\n}\n'):
                            os.write(writer,part);time.sleep(.002)
                    finally:os.close(writer)
                producer=threading.Thread(target=produce);producer.start()
                try:reports.append(runner.sandbox_information(reader,timeout=1)['child-pid'])
                finally:producer.join()
            for pid in range(200,208):
                thread=threading.Thread(target=one,args=(pid,));threads.append(thread);thread.start()
            for thread in threads:thread.join(timeout=2)
            self.assertEqual(sorted(reports),list(range(200,208)))

    def test_both_profiles_share_parser_and_cleanup_after_stopping_child(self):
        functions=[]
        for runner in RUNNERS:
            tree=ast.parse(Path(runner.__file__).read_text())
            functions.append(ast.dump(next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='sandbox_information'),include_attributes=False))
            main=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='main')
            cleanup=next(node.finalbody for node in reversed(main.body) if isinstance(node,ast.Try))
            self.assertIn('process.kill()',ast.unparse(cleanup[0]))
            self.assertEqual(ast.unparse(cleanup[1]),'gatefile.close()')
        self.assertEqual(*functions)


if __name__=='__main__':unittest.main()
