"""Exercise the actual scheduled-soak parser with mocked curl, never the network."""
import json
from pathlib import Path
import textwrap
import types
import unittest

workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/pi-v1-tests.yml').read_text(encoding='utf-8')
start = workflow.index('          legacy_markers=')
end = workflow.index('          unsafe_failures=[]', start)
source = textwrap.dedent(workflow[start:end])
MARKER = '\n__PI_CURL_METRICS__'

class SoakEvidenceTest(unittest.TestCase):
    def ask(self, body='', code=0, status='200', headers=('request-123', 'pi_chat;dur=5'), raw=None):
        output = raw if raw is not None else body + MARKER + '\t'.join([status,'0.01','0.02','0.03','22.00',*headers])
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            return types.SimpleNamespace(returncode=code, stdout=output, stderr='PRIVATE STDERR')
        scope = {'json':json, 'time':types.SimpleNamespace(time=lambda:0), 'subprocess':types.SimpleNamespace(run=run), 'url':'https://invalid.test/chat'}
        exec(compile(source, '<scheduled-soak>', 'exec'), scope)
        result = scope['ask']((0,0,'PRIVATE PROMPT'))
        self.assertIn('%header{x-pi-request-id}', calls[0][-2])
        self.assertIn('%header{server-timing}', calls[0][-2])
        self.assertNotIn('%{header{', calls[0][-2])
        self.assertNotIn('PRIVATE', json.dumps(result))
        return result[0], result[2]

    def test_zero_byte_timeout_preserves_empty_headers(self):
        ready,d = self.ask(code=28,status='000',headers=('',''))
        self.assertFalse(ready)
        self.assertEqual(d['transport'],'curl:28')
        self.assertTrue(d['zero_byte'])
        self.assertEqual(d['curlTotalSeconds'],'22.00')
        self.assertIsNone(d['requestId'])
        self.assertIsNone(d['serverTiming'])

    def test_empty_body(self):
        _,d=self.ask(body=' \n',headers=('',''))
        self.assertEqual(d['transport'],'empty-response-body')
        self.assertTrue(d['zero_byte'])

    def test_success(self):
        body=json.dumps({'ok':True,'truth':'model-response','source':'pi-chat-cloudflare-ai:test','answer':'PRIVATE ANSWER ' * 20})
        ready,d=self.ask(body)
        self.assertTrue(ready)
        self.assertTrue(d['safe'])
        self.assertEqual(d['requestId'],'request-123')

    def test_bounded_timeout(self):
        body=json.dumps({'ok':False,'truth':'unknown','status':'provider_timeout','error':'customer_request_deadline_exceeded','answer':'PRIVATE ANSWER'})
        ready,d=self.ask(body,status='503')
        self.assertFalse(ready)
        self.assertTrue(d['safe'])

    def test_missing_and_malformed_metrics(self):
        for raw,expected in [('', 'curl:28:missing-metrics'),(MARKER+'000\t0','invalid-curl-metrics')]:
            _,d=self.ask(code=28,raw=raw)
            self.assertEqual(d['transport'],expected)
            self.assertTrue(d['zero_byte'])

    def test_invalid_json(self):
        _,d=self.ask('PRIVATE INVALID BODY')
        self.assertEqual(d['transport'],'invalid-json')

if __name__ == '__main__':
    unittest.main()
