#!/usr/bin/env python3
"""Hourly host backup of one agent's persistent Docker mounts with Restic."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

BACKUPS = Path('/srv/agent-backups')
STATE = Path('/var/lib/codex-agent-backup')
SOURCE = Path('/srv/codex-agent')
PASSWORDS = Path('/etc/codex-agent/backup-keys')
RESTIC = '/usr/local/bin/restic'


def read_settings(file):
    settings = json.loads(Path(file).read_text())
    for key in ('source', 'backup_root', 'state_root', 'password_root', 'restic'):
        if not isinstance(settings.get(key), str) or not Path(settings[key]).is_absolute():
            raise RuntimeError(f'Backup setting {key} must be an absolute path')
    names = settings.get('instances')
    if not isinstance(names, list) or not names or any(not isinstance(n, str) or not re.fullmatch('[a-z][a-z0-9-]{0,31}', n) for n in names) or len(set(names)) != len(names):
        raise RuntimeError('Configure a nonempty list of distinct instance names')
    return settings


def instance_files(source, name):
    directory = source / 'private' / 'instances' / name
    if not (directory / 'agent.env').is_file() or not (directory / 'seed').is_dir():
        raise RuntimeError('Private instance configuration is missing')
    return [directory, source / 'compose.yaml']


def reject_repository_overlap(paths):
    repository = BACKUPS.resolve()
    for file in paths:
        candidate = Path(file).resolve()
        if candidate == Path('/') or candidate == repository or candidate in repository.parents or repository in candidate.parents:
            raise RuntimeError('Backup source overlaps the repositories')


def mount_sources(container):
    mounts = [m for m in container['Mounts'] if m['Type'] in ('bind', 'volume')]
    if not mounts or any(not Path(m['Source']).exists() for m in mounts):
        raise RuntimeError('A persistent container mount is missing')
    roots = sorted({str(Path(m['Source']).resolve()) for m in mounts})
    reject_repository_overlap(roots)
    # Preserve nested mount metadata but avoid scanning a subtree twice.
    roots = [p for p in roots if not any(Path(parent) in Path(p).parents for parent in roots)]
    workspace = next((Path(m['Source']) for m in mounts if m['Destination'] == '/workspace'), None)
    if not workspace:
        raise RuntimeError('Missing workspace mount')
    return roots, workspace, mounts


def sqlite_snapshot(source, destination):
    if not source.is_file():
        raise RuntimeError('Agent database is missing')
    fd, temporary = tempfile.mkstemp(prefix='.sqlite-', dir=destination.parent)
    os.close(fd)
    try:
        with sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True, timeout=10) as original:
            with sqlite3.connect(temporary) as copy:
                original.backup(copy, pages=256, sleep=0.05)
                if copy.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise RuntimeError('SQLite snapshot validation failed')
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run_restic(args, env, log):
    with log.open('a') as output:
        result = subprocess.run([RESTIC, *args], env=env, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        # Exit 3 means incomplete data and must not be treated as success.
        raise RuntimeError(f'Restic exited {result.returncode}; inspect {log}')


def database_snapshots(workspace, state):
    records = []
    main = workspace / 'state/assistant.sqlite'
    snapshot = state / 'assistant.sqlite'
    sqlite_snapshot(main, snapshot)
    records.append({'snapshot': str(snapshot), 'destination': str(main)})
    # Read the snapshotted catalog, so every recorded conversation has a backup.
    with sqlite3.connect(snapshot.resolve().as_uri() + '?mode=ro', uri=True) as catalog:
        exists = catalog.execute("SELECT name FROM sqlite_master WHERE name='conversations'").fetchone()
        groups = catalog.execute("SELECT id FROM conversations WHERE kind='group'").fetchall() if exists else []
        meta = catalog.execute("SELECT name FROM sqlite_master WHERE name='meta'").fetchone()
        shared = catalog.execute("SELECT value FROM meta WHERE key='shared-owner-store-version'").fetchone() if meta else None
    for (identity,) in groups:
        if not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', identity):
            raise RuntimeError('Invalid conversation identity in backup catalog')
        source = workspace / 'state/conversations' / identity / 'assistant.sqlite'
        # Version 2 stores active conversations in the canonical snapshot. Keep
        # existing legacy database copies, but new chats have no separate file.
        if shared and shared[0] == '2' and not source.exists():
            continue
        if source.resolve() != workspace.resolve() / 'state/conversations' / identity / 'assistant.sqlite':
            raise RuntimeError('Conversation database escaped workspace')
        target = state / 'conversations' / identity / 'assistant.sqlite'
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        sqlite_snapshot(source, target)
        records.append({'snapshot': str(target), 'destination': str(source)})
    return records


def backup_agent(name, settings_file):
    if not re.fullmatch('[a-z][a-z0-9-]{0,63}', name):
        raise RuntimeError('Invalid agent name')
    os.umask(0o077)
    state = STATE / name
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'backup.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        identifiers = subprocess.check_output([str(SOURCE / 'bin/agent'), 'ps', name, '-a', '-q', 'assistant'], text=True).split()
        if len(identifiers) != 1:
            raise RuntimeError('Expected exactly one container for the selected instance')
        container = json.loads(subprocess.check_output(['docker', 'inspect', identifiers[0]]))[0]
        roots, workspace, mounts = mount_sources(container)
        # Host SQLite backup API also works when the container is stopped.
        databases = database_snapshots(workspace, state)
        files = instance_files(SOURCE, name) + [Path(settings_file)]
        manifest = {'agent': name, 'created': datetime.now(timezone.utc).isoformat(),
                    'mounts': [{k: m[k] for k in ('Type', 'Source', 'Destination', 'RW')} for m in mounts],
                    'database_restore': databases[0], 'databases_restore': databases,
                    'consistency': 'SQLite online snapshot; other files are a live filesystem backup'}
        (state / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        paths = roots + [str(file) for file in files] + [record['snapshot'] for record in databases] + [str(state / 'manifest.json')]
        reject_repository_overlap(paths)
        password = PASSWORDS / f'{name}.password'
        if not password.is_file() or password.stat().st_uid != 0 or password.stat().st_mode & 0o077:
            raise RuntimeError('Restic password must be a root-only file')
        if not (BACKUPS / name / 'config').is_file():
            raise RuntimeError('Restic repository is not initialized')
        env = {**os.environ, 'RESTIC_REPOSITORY': str(BACKUPS / name),
               'RESTIC_PASSWORD_FILE': str(password), 'RESTIC_CACHE_DIR': f'/var/cache/codex-agent-backup/{name}'}
        log = state / 'last-run.log'
        log.write_text('')
        args = ['backup', '--json', '--host', socket.gethostname(), '--tag', f'agent:{name}', '--group-by', 'host,tags']
        args += ['--exclude', str(workspace / 'state/executors/control.sock')]
        for record in databases:
            for suffix in ('', '-wal', '-shm'):
                args += ['--exclude', record['destination'] + suffix]
        run_restic(args + ['--', *paths], env, log)
        summary = None
        for line in log.read_text().splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if item.get('message_type') == 'summary':
                summary = item
        if not summary or not summary.get('snapshot_id'):
            raise RuntimeError('Backup completed without a snapshot receipt')
        # One repository per agent; group by tag so path changes don't retain old
        # mount lists forever. Prune runs only after a complete successful backup.
        run_restic(['forget', '--tag', f'agent:{name}', '--group-by', 'tags', '--keep-within', '1m', '--prune'], env, log)
        result = {key: summary[key] for key in ('snapshot_id', 'total_files_processed', 'total_bytes_processed', 'data_added', 'data_added_packed', 'total_duration') if key in summary}
        result.update(agent=name, completed=datetime.now(timezone.utc).isoformat(), persistent_mounts=len(mounts))
        (state / 'last-success.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))


if __name__ == '__main__':
    try:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('--config', type=Path, default=Path('/etc/codex-agent/backups.json'))
        parser.add_argument('name')
        args = parser.parse_args()
        if os.geteuid() != 0:
            raise RuntimeError('Run on the Linux Docker host as root')
        settings = read_settings(args.config)
        if args.name not in settings['instances']:
            raise RuntimeError('Instance is not listed in the backup configuration')
        SOURCE, BACKUPS, STATE, PASSWORDS = (Path(settings[key]) for key in ('source', 'backup_root', 'state_root', 'password_root'))
        RESTIC = settings['restic']
        backup_agent(args.name, args.config)
    except (RuntimeError, OSError, subprocess.SubprocessError, sqlite3.Error) as error:
        print(f'Agent backup failed: {error}', file=sys.stderr)
        sys.exit(1)
