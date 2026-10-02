import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'shared-skill/agent-messaging/scripts/agent-mail.py'
spec = importlib.util.spec_from_file_location('agent_mail', MODULE)
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class MailClientTests(unittest.TestCase):
    def test_body_is_stdin_and_never_shell_code(self):
        content = 'quotes " and $(touch /tmp/unsafe); `whoami`\nsecond line'
        with patch.object(client.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '{"ok":true}', '')) as run:
            result = client.request({'host': 'example', 'command': ['/srv/my repo/bin/mailbox', 'request']}, 'send', {'text': content})
        self.assertTrue(result['ok'])
        args, kwargs = run.call_args
        self.assertNotIn(content, ' '.join(args[0]))
        self.assertEqual(json.loads(kwargs['input'])['args']['text'], content)
        self.assertEqual(args[0][-1], "'/srv/my repo/bin/mailbox' request")
        self.assertNotIn('shell', kwargs)

    def test_option_injection_and_raw_ssh_errors_are_rejected(self):
        with self.assertRaises(ValueError):
            client.request({'host': '-oProxyCommand=bad', 'command': ['x']}, 'list', {})
        with patch.object(client.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'PRIVATE DATA')):
            with self.assertRaisesRegex(RuntimeError, 'delivery may be uncertain') as error:
                client.request({'host': 'example', 'command': ['x']}, 'list', {})
        self.assertNotIn('PRIVATE DATA', str(error.exception))
