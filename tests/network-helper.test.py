import importlib.machinery
import importlib.util
import pathlib
import unittest
import io
import contextlib
from unittest.mock import patch

p=pathlib.Path(__file__).resolve().parents[1]/'deploy/gpuq-network'
s=importlib.util.spec_from_loader('network_helper',importlib.machinery.SourceFileLoader('network_helper',str(p)))
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class NetworkTests(unittest.TestCase):
    def test_secrets_not_exposed(self):
        out=m.inspect({'HTTPS_PROXY':'http://user:secret@example.test:3128','HOME':'/home/gpuq'})
        self.assertNotIn('secret',str(out));self.assertTrue(out['proxyConfigured']['HTTPS_PROXY'])
    def test_command_only_environment(self):
        before={'PATH':'/usr/bin','ALL_PROXY':'old','no_proxy':'*'}
        after=m.proxy_environment('http://proxy.test:3128',before)
        self.assertEqual(before['ALL_PROXY'],'old');self.assertNotIn('ALL_PROXY',after)
        self.assertEqual(after['HTTPS_PROXY'],'http://proxy.test:3128');self.assertNotEqual(after['no_proxy'],'*')
    def test_bad_targets(self):
        for value in ('file:///etc/passwd','http://name:secret@example.test','https://bad host','ftp://example.test'):
            with self.assertRaises(ValueError):m.url(value)
    def test_proxy_endpoint_only(self):
        for value in ('http://p.test/path','http://p.test?q=secret','socks5://p.test:1080'):
            with self.assertRaises(ValueError):m.proxy_environment(value,{})
    def test_error_no_secret(self):
        with patch.object(m.socket,'getaddrinfo',side_effect=OSError(11,'secret')),patch.object(m.urllib.request,'build_opener',side_effect=OSError(11,'secret')):
            out=m.check('https://p.test/?signed=secret')
        self.assertNotIn('secret',str(out));self.assertFalse(out['http']['reachable'])
    def test_show_never_networks(self):
        with patch.object(m.socket,'getaddrinfo',side_effect=AssertionError),patch('builtins.print'):
            self.assertEqual(m.main(['show']),0)
    def test_argument_errors_hide_values(self):
        out=io.StringIO()
        with contextlib.redirect_stderr(out),self.assertRaises(SystemExit):
            m.main(['show','--proxy','http://user:secret@proxy.test'])
        self.assertNotIn('secret',out.getvalue())
    def test_proxy_auth_is_not_target_reachable(self):
        with patch.object(m.socket,'getaddrinfo',return_value=[]),patch.object(m.urllib.request,'build_opener') as opener:
            opener.return_value.open.side_effect=m.urllib.error.HTTPError('http://proxy',407,'auth',{},None)
            result=m.check('https://pypi.org/simple/')
        self.assertFalse(result['http']['reachable']);self.assertTrue(result['http']['proxyAuthRequired'])
    def test_https_downgrade_refused(self):
        with self.assertRaises(ValueError):
            m.NoDowngrade().redirect_request(m.urllib.request.Request('https://site.test'),None,302,'',{},'http://site.test')

if __name__=='__main__':unittest.main()
