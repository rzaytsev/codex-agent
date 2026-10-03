import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


MODULE = Path(__file__).resolve().parents[1] / 'scripts/tdl-user.py'
spec = importlib.util.spec_from_file_location('tdl_user', MODULE)
tdl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tdl)


class TdlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.binary = self.root / 'fake-tdl'
        self.binary.write_text('''#!/usr/bin/env python3
import json,os,pathlib,sys,time
home=pathlib.Path(os.environ['HOME'])
(home/'result.json').write_text(json.dumps({'home':str(home),'storage':json.loads(os.environ['TDL_STORAGE']),'ns':os.environ['TDL_NS'],'debug':os.environ['TDL_DEBUG'],'keys':sorted(os.environ),'args':sys.argv[1:],'pid':os.getpid()}))
if sys.argv[1:]==['hold']:
    while True: time.sleep(0.1)
''')
        self.binary.chmod(0o700)
        self.runner = self.root / 'runner.py'
        self.runner.write_text(f'''import importlib.util,sys
s=importlib.util.spec_from_file_location('tdl_user',{str(MODULE)!r});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
sys.exit(m.main(args=sys.argv[2:],binary=sys.argv[1]))
''')

    def run_wrapper(self, workspace, args):
        return subprocess.run([sys.executable, str(self.runner), str(self.binary), *args],
                              env={**os.environ, 'WORKSPACE_DIR': str(workspace), 'TELEGRAM_BOT_TOKEN': 'synthetic', 'TDL_NS': 'wrong'},
                              capture_output=True, text=True, timeout=5)

    def test_private_persisted_isolated_sessions_and_environment(self):
        for name in ('alpha', 'beta'):
            workspace = self.root / name
            self.assertEqual(self.run_wrapper(workspace, ['chat', 'ls', '-o', 'json']).returncode, 0)
            home = workspace / 'state/tdl'
            result = json.loads((home / 'result.json').read_text())
            self.assertEqual(result['storage'], {'type': 'bolt', 'path': str(home / '.tdl/data')})
            self.assertEqual(result['ns'], 'owner')
            self.assertEqual(result['debug'], 'false')
            self.assertNotIn('TELEGRAM_BOT_TOKEN', result['keys'])
            self.assertEqual(result['args'], ['chat', 'ls', '-o', 'json'])
            self.assertEqual(home.stat().st_mode & 0o777, 0o700)
            self.assertEqual((home / 'result.json').stat().st_mode & 0o777, 0o600)
            marker = home / 'preserved'
            marker.write_text('synthetic session marker')
            self.assertEqual(self.run_wrapper(workspace, ['version']).returncode, 0)
            self.assertEqual(marker.read_text(), 'synthetic session marker')

    def test_overrides_cannot_select_other_sessions_or_enable_debug(self):
        for args in (['--ns=other'], ['-nother'], ['--storage', 'type=file'], ['--debug']):
            result = self.run_wrapper(self.root / 'alpha', args)
            self.assertEqual(result.returncode, 1)
            self.assertIn('managed by this instance', result.stderr)

    def test_lock_serializes_and_termination_waits_for_child(self):
        workspace = self.root / 'alpha'
        first = subprocess.Popen([sys.executable, str(self.runner), str(self.binary), 'hold'],
                                 env={**os.environ, 'WORKSPACE_DIR': str(workspace)},
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: first.poll() is None and first.kill())
        output = workspace / 'state/tdl/result.json'
        for _ in range(200):
            if output.exists():
                break
            time.sleep(0.005)
        self.assertTrue(output.exists())
        child = json.loads(output.read_text())['pid']
        busy = self.run_wrapper(workspace, ['version'])
        self.assertEqual(busy.returncode, 1)
        self.assertIn('busy', busy.stderr)
        first.send_signal(signal.SIGTERM)
        first.communicate(timeout=5)
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)
        self.assertEqual(self.run_wrapper(workspace, ['version']).returncode, 0)

    def test_symlink_session_directory_is_rejected(self):
        workspace = self.root / 'alpha'
        (workspace / 'state').mkdir(parents=True)
        target = self.root / 'outside'
        target.mkdir()
        (workspace / 'state/tdl').symlink_to(target)
        result = self.run_wrapper(workspace, ['version'])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(list(target.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
