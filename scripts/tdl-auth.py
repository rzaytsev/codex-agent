#!/usr/bin/env python3
"""Private PTY adapter for pinned tdl QR login. Only controlled JSON leaves stdout."""
import codecs
import ctypes
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import selectors
import shutil
import signal
import subprocess
import sys
import termios
import tempfile
import time
from PIL import Image

ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
# go-qrcode ToSmallString(false) prints WHITE blocks (the terminal background is black).
PIXELS = {' ': (0, 0), '█': (255, 255), '▀': (255, 0), '▄': (0, 255)}


def render(rows, destination):
    width = len(rows[0])
    if not 29 <= width <= 185 or width % 4 != 1 or len(rows) != (width + 1) // 2:
        raise ValueError('Invalid QR dimensions')
    image = Image.new('L', (width, width), 255)
    for y, row in enumerate(rows):
        if len(row) != width or any(c not in PIXELS for c in row):
            raise ValueError('Invalid QR frame')
        for x, char in enumerate(row):
            for half, value in enumerate(PIXELS[char]):
                if y * 2 + half < width:
                    image.putpixel((x, y * 2 + half), value)
    image.resize((width * 10, width * 10), Image.Resampling.NEAREST).save(destination)


def event(kind, **fields):
    print(json.dumps({'type': kind, **fields}), flush=True)


def cleanup(home):
    home = Path(home)
    if not home.exists() or home.is_symlink():
        return
    with os.fdopen(os.open(home / 'session.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        for stage in home.glob('qr-login-*'):
            if stage.is_dir() and not stage.is_symlink():
                shutil.rmtree(stage)


def login(home, owner, binary='/usr/local/libexec/tdl', timeout=600):
    os.umask(0o077)
    home = Path(home)
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    if home.is_symlink() or (home / '.tdl').is_symlink():
        raise RuntimeError('Unsafe session path')
    home.chmod(0o700)
    with os.fdopen(os.open(home / 'session.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            event('busy')
            return 1
        # A previous process may have died. The lock proves it no longer owns staging.
        for old in home.glob('qr-login-*'):
            if old.is_dir() and not old.is_symlink():
                shutil.rmtree(old)
        stage = Path(tempfile.mkdtemp(prefix='qr-login-', dir=home))
        master, slave = pty.openpty()
        child = None
        try:
            env = {key: os.environ[key] for key in ('PATH', 'LANG') if key in os.environ}
            env.update(HOME=str(stage), TERM='xterm', TDL_NS='owner', TDL_DEBUG='false',
                       TDL_STORAGE=json.dumps({'type': 'bolt', 'path': str(stage / '.tdl/data')}))
            parent_pid = os.getpid()
            def child_setup():
                os.setsid()
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
                if sys.platform == 'linux':
                    # Prevent an orphaned credential writer if the helper is killed.
                    if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent_pid:
                        os._exit(1)
            child = subprocess.Popen([binary, 'login', '-T', 'qr'], env=env,
                                     stdin=slave, stdout=slave, stderr=slave, preexec_fn=child_setup)
            os.close(slave)
            slave = None
            stop = False
            def cancel(_signum, _frame):
                nonlocal stop
                stop = True
            previous = {sig: signal.signal(sig, cancel) for sig in (signal.SIGTERM, signal.SIGINT)}
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(master, selectors.EVENT_READ, 'pty')
                    selector.register(sys.stdin, selectors.EVENT_READ, 'control')
                    decoder = codecs.getincrementaldecoder('utf-8')('replace')
                    buffer, rows, version, identity = '', [], 0, None
                    deadline = time.monotonic() + timeout
                    while not stop and time.monotonic() < deadline:
                        for key, _mask in selector.select(0.1):
                            if key.data == 'control':
                                # stdin EOF also cancels when the owning service dies.
                                os.read(sys.stdin.fileno(), 128)
                                stop = True
                                continue
                            try:
                                data = os.read(master, 8192)
                            except OSError:
                                data = b''
                            if not data:
                                selector.unregister(master)
                                continue
                            buffer += decoder.decode(data)
                            if len(buffer) > 65536:
                                raise RuntimeError('Output limit')
                            plain = ANSI.sub('', buffer).replace('\r', '')
                            if 'Enter 2FA Password:' in plain or 'SESSION_PASSWORD_NEEDED' in plain:
                                event('password_required')
                                return 1
                            match = re.search(r'Login successfully! ID: (\d+),', plain)
                            if match:
                                identity = match.group(1)
                            while '\n' in buffer:
                                line, buffer = buffer.split('\n', 1)
                                line = ANSI.sub('', line).replace('\r', '')
                                if 29 <= len(line) <= 185 and all(c in PIXELS for c in line):
                                    if rows and len(line) != len(rows[0]):
                                        rows = []
                                    rows.append(line)
                                    if len(rows) == (len(rows[0]) + 1) // 2:
                                        version += 1
                                        image = stage / f'qr-{version}.png'
                                        render(rows, image)
                                        event('qr', path=str(image), version=version)
                                        rows = []
                                else:
                                    rows = []
                            if child.poll() is not None and not selector.get_map().get(master):
                                break
                        if child.poll() is not None and not selector.get_map().get(master):
                            break
                    if stop:
                        event('cancelled')
                        return 1
                    if time.monotonic() >= deadline:
                        event('expired')
                        return 1
                    if child.wait() != 0 or identity is None:
                        event('failed')
                        return 1
                    if identity != str(owner):
                        event('owner_mismatch')
                        return 1
                    event('verified')
                    # The service can cancel before promotion; no passwords are accepted here.
                    ready = []
                    commit_deadline = time.monotonic() + 5
                    while not stop and not ready and time.monotonic() < commit_deadline:
                        ready = selector.select(0.1)
                    if stop or not ready or os.read(sys.stdin.fileno(), 128) != b'commit\n':
                        event('cancelled')
                        return 1
                    source = stage / '.tdl/data/owner'
                    target = home / '.tdl/data'
                    target.mkdir(mode=0o700, parents=True, exist_ok=True)
                    if target.is_symlink() or source.is_symlink() or not source.is_file():
                        raise RuntimeError('Unsafe session storage')
                    with source.open('rb') as saved:
                        os.fsync(saved.fileno())
                    os.replace(source, target / 'owner')
                    directory = os.open(target, os.O_RDONLY)
                    try:
                        os.fsync(directory)
                    finally:
                        os.close(directory)
                    event('saved')
                    return 0
            finally:
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
        finally:
            if child is not None and child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            os.close(master)
            if slave is not None:
                os.close(slave)
            shutil.rmtree(stage)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--cleanup':
            os.umask(0o077)
            cleanup(sys.argv[2])
            raise SystemExit(0)
        if len(sys.argv) != 3 or not sys.argv[2].isdigit():
            raise ValueError('Invalid invocation')
        raise SystemExit(login(sys.argv[1], sys.argv[2]))
    except BrokenPipeError:
        raise SystemExit(1)
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
        event('failed')
        raise SystemExit(1)
