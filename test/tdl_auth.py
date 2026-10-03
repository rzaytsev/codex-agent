import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'scripts/tdl-auth.py'
try:
    from PIL import Image
except ImportError:
    Image = None


@unittest.skipUnless(Image, 'Pillow is required (installed in the Docker image)')
class QrLoginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'tdl'
        self.target = self.home / '.tdl/data/owner'
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b'old-session')
        self.binary = self.root / 'fake-tdl'
        self.runner = self.root / 'run.py'
        self.runner.write_text(f'''import importlib.util,sys
s=importlib.util.spec_from_file_location('auth',{str(MODULE)!r});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
sys.exit(m.login(sys.argv[1],'123',binary=sys.argv[2],timeout=3))
''')

    def start(self, ending):
        self.binary.write_text('''#!/usr/bin/env python3
import json,os,pathlib,sys,time
p=pathlib.Path(json.loads(os.environ['TDL_STORAGE'])['path']);p.mkdir(parents=True);(p/'owner').write_bytes(b'new-session')
print('Scan QR code with your Telegram app...',flush=True)
print(('█'*29+'\\n')*15,end='',flush=True)
print('\\x1b[15A',end='',flush=True)
''' + ending)
        self.binary.chmod(0o700)
        child = subprocess.Popen([sys.executable, str(self.runner), str(self.home), str(self.binary)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: child.poll() is None and child.kill())
        self.addCleanup(child.stdin.close)
        self.addCleanup(child.stdout.close)
        self.addCleanup(child.stderr.close)
        return child

    def read(self, child):
        line = child.stdout.readline()
        self.assertTrue(line, "Helper closed without an event")
        return json.loads(line)

    def test_qr_reconstruction_and_verified_atomic_promotion(self):
        child = self.start("print('Login successfully! ID: 123, Username: synthetic',flush=True)\n")
        qr = self.read(child)
        self.assertEqual(qr['type'], 'qr')
        image = Image.open(qr['path'])
        self.assertEqual(image.size, (290, 290))
        self.assertEqual(image.getpixel((0, 0)), 255)
        self.assertEqual(self.read(child)['type'], 'verified')
        self.assertEqual(self.target.read_bytes(), b'old-session')
        child.stdin.write('commit\n');child.stdin.flush()
        self.assertEqual(self.read(child)['type'], 'saved')
        self.assertEqual(child.wait(timeout=5), 0)
        self.assertEqual(self.target.read_bytes(), b'new-session')
        self.assertFalse(Path(qr['path']).exists())
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o600)

    def test_mismatch_password_cancel_and_parent_disconnect_preserve_session(self):
        for ending, expected in [("print('Login successfully! ID: 456, Username: synthetic',flush=True)\n", 'owner_mismatch'),
                                 ("print('Enter 2FA Password:',end='',flush=True);time.sleep(10)\n", 'password_required'),
                                 ('time.sleep(10)\n', 'cancelled')]:
            with self.subTest(expected=expected):
                child = self.start(ending)
                qr = self.read(child)
                if qr['type'] == 'password_required':
                    self.assertEqual(expected, 'password_required')
                    child.wait(timeout=5)
                    self.assertEqual(self.target.read_bytes(), b'old-session')
                    continue
                if expected == 'cancelled':
                    child.stdin.close()
                self.assertEqual(self.read(child)['type'], expected)
                self.assertEqual(child.wait(timeout=5), 1)
                self.assertEqual(self.target.read_bytes(), b'old-session')
                self.assertFalse(Path(qr['path']).exists())

    def test_lock_excludes_other_tdl_and_signal_cancels(self):
        first = self.start('time.sleep(10)\n');self.read(first)
        second = self.start('time.sleep(10)\n')
        self.assertEqual(self.read(second)['type'], 'busy');second.wait(timeout=5)
        first.send_signal(signal.SIGTERM)
        self.assertEqual(self.read(first)['type'], 'cancelled');first.wait(timeout=5)
        self.assertEqual(self.target.read_bytes(), b'old-session')

    def test_refresh_failure_and_cleanup_preserve_existing_session(self):
        child = self.start("print(('█'*29+'\\n')*15,end='',flush=True);sys.exit(2)\n")
        first = self.read(child);second = self.read(child)
        self.assertEqual((first['version'], second['version']), (1, 2))
        self.assertEqual(self.read(child)['type'], 'failed');child.wait(timeout=5)
        self.assertEqual(self.target.read_bytes(), b'old-session')
        spec = importlib.util.spec_from_file_location('auth', MODULE)
        module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        abandoned = self.home / 'qr-login-abandoned';abandoned.mkdir();(abandoned/'private').write_bytes(b'synthetic')
        module.cleanup(self.home)
        self.assertFalse(abandoned.exists());self.assertEqual(self.target.read_bytes(), b'old-session')

    def test_white_terminal_blocks_map_to_correct_two_pixel_rows(self):
        spec = importlib.util.spec_from_file_location('auth', MODULE)
        module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        rows = [' ▀▄█'+'█'*25]+['█'*29]*14
        target = self.root / 'frame.png';module.render(rows, target)
        image = Image.open(target)
        for x, expected in enumerate(((0, 0), (255, 0), (0, 255), (255, 255))):
            self.assertEqual((image.getpixel((x*10, 0)), image.getpixel((x*10, 10))), expected)


if __name__ == '__main__':
    unittest.main()
