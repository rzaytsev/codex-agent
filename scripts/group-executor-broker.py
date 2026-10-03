#!/usr/bin/env python3
"""Host-owned executor broker. Never mount Docker access into an assistant."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import socketserver
import subprocess
import threading
import uuid


def executor_command(instance, request):
    if set(request) != {'conversation', 'writable'} or type(request['writable']) is not bool:
        raise ValueError('Invalid executor request')
    identity = request['conversation']
    if not isinstance(identity, str) or str(uuid.UUID(identity)) != identity:
        raise ValueError('Invalid conversation identity')
    root = Path(instance['workspace']).resolve(strict=True)
    workspace = root / 'conversations' / identity
    if workspace.resolve(strict=True) != workspace or not workspace.is_dir():
        raise ValueError('Noncanonical conversation workspace')
    target = '/workspace/conversations/' + identity
    name = 'codex-group-' + uuid.uuid4().hex
    command = ['docker', 'run', '--rm', '-i', '--name', name,
               '--label', 'codex-agent.group-executor=true', '--network', 'none',
               '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
               '--memory=512m', '--cpus=1', '--pids-limit=128',
               '--tmpfs', '/tmp:size=128m,exec',
               '--mount', f'type=bind,src={workspace},dst={target},readonly',
               '--workdir', target, '--env', 'HOME=/tmp', '--env', 'CODEX_HOME=/tmp/codex']
    for folder in ('outputs', 'projects', 'tasks'):
        source = workspace / folder
        if source.resolve(strict=True) != source or not source.is_dir():
            raise ValueError('Noncanonical executor output directory')
        if request['writable']:
            command += ['--mount', f'type=bind,src={source},dst={target}/{folder}']
    command += [instance['image'], 'node', '/app/node_modules/@openai/codex/bin/codex.js',
                'exec-server', '--listen', 'stdio', '--concurrent-requests', '8']
    return name, command


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        process = None
        name = None
        admitted = self.server.slots.acquire(blocking=False)
        if not admitted:
            return
        try:
            self.connection.settimeout(15)
            line = self.rfile.readline(4097)
            if len(line) > 4096 or not line.endswith(b'\n'):
                raise ValueError('Invalid executor request')
            name, command = executor_command(self.server.instance, json.loads(line))
            with self.server.active_lock:
                self.server.active.add(name)
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, bufsize=0)
            # Honor the service's supported 24-hour worker timeout. The service
            # owns cancellation; the host bound is only an orphan guard.
            self.connection.settimeout(86460)
            self.wfile.write(b'READY\n')
            self.wfile.flush()

            def downstream():
                try:
                    while data := process.stdout.read(65536):
                        self.wfile.write(data)
                        self.wfile.flush()
                except (OSError, ValueError):
                    pass
                finally:
                    try:
                        self.connection.shutdown(2)
                    except OSError:
                        pass

            relay = threading.Thread(target=downstream, daemon=True)
            relay.start()
            while data := self.rfile.read1(65536):
                process.stdin.write(data)
            process.stdin.close()
        except (OSError, ValueError, KeyError):
            pass
        finally:
            if name:
                subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=30)
            if process:
                process.wait(timeout=30)
            with self.server.active_lock:
                self.server.active.discard(name)
            self.server.slots.release()


class Broker(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    def stop(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    settings = json.loads(Path(args.config).read_text())
    servers = []
    for instance in settings['instances']:
        if not re.fullmatch(r'[a-zA-Z0-9_.:/-]+', instance['image']):
            raise ValueError('Invalid executor image')
        root = Path(instance['workspace']).resolve(strict=True)
        directory = root / 'state' / 'executors'
        directory.mkdir(parents=True, exist_ok=True)
        if directory.resolve(strict=True) != directory:
            raise ValueError('Noncanonical broker directory')
        address = directory / 'control.sock'
        if address.exists():
            raise ValueError('Broker socket already exists; verify the old broker before removal')
        server = Broker(str(address), Handler)
        server.instance = instance
        limit = instance.get('maxExecutions', 4)
        if type(limit) is not int or not 1 <= limit <= 16:
            raise ValueError('Invalid executor limit')
        server.slots = threading.BoundedSemaphore(limit)
        server.active = set()
        server.active_lock = threading.Lock()
        os.chmod(address, 0o600)
        servers.append(server)
    try:
        for server in servers[1:]:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for server in servers:
            server.server_close()
            with server.active_lock:
                for name in server.active.copy():
                    subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, timeout=30)
            Path(server.server_address).unlink(missing_ok=True)


if __name__ == '__main__':
    main()
