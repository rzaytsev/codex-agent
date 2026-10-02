#!/usr/bin/env python3
"""Check Git publication candidates without printing matching private content."""
import argparse
from pathlib import Path
import re
import subprocess
import sys


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staged', action='store_true', help='Inspect index bytes instead of working-tree candidates')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    options = ['--cached'] if args.staged else ['--cached', '--others', '--exclude-standard']
    names = sorted(set(git(root, 'ls-files', '-z', *options).decode().strip('\0').split('\0')) - {''})
    denyfile = root / 'private/operations/publication-denylist.txt'
    denied = [line.casefold() for line in denyfile.read_text().splitlines() if line and not line.startswith('#')] if denyfile.exists() else []
    patterns = [
        ('private key', re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')),
        ('Telegram token', re.compile(r'\b\d{8,12}:[A-Za-z0-9_-]{30,}\b')),
        ('access token', re.compile(r'\b(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_-]{20,}\b')),
        ('personal host path', re.compile(r'/(?:Users|home)/[A-Za-z][A-Za-z0-9._-]+/(?:projects|notes|\.codex)/')),
    ]
    problems = []
    for name in names:
        file = root / name
        parts = Path(name).parts
        if any(p in {'private', 'instances', '.trigger-tree', '__pycache__', '.codex-data', 'workspace', 'node_modules', 'backups'} for p in parts) or (name.endswith('.env') or Path(name).name.startswith('.env') and not name.endswith('.example')):
            problems.append((name, 'private/runtime path'))
            continue
        if args.staged:
            mode = git(root, 'ls-files', '--stage', '--', name).decode().split()[0]
            if mode not in {'100644', '100755'}:
                problems.append((name, 'nonregular index entry'))
                continue
            content = git(root, 'show', ':' + name)
        else:
            if file.is_symlink() or not file.is_file():
                problems.append((name, 'nonregular or missing file'))
                continue
            content = file.read_bytes()
        try:
            text = content.decode('utf-8')
        except UnicodeDecodeError:
            problems.append((name, 'binary file requires manual review'))
            continue
        folded = (name + '\n' + text).casefold()
        if any(value in folded for value in denied):
            problems.append((name, 'private denylist match'))
        for label, pattern in patterns:
            if pattern.search(text):
                problems.append((name, label))
    for name, category in problems:
        print(f'{name}: {category}', file=sys.stderr)
    print(f'Checked {len(names)} Git {"index files" if args.staged else "publication candidates"}; {len(problems)} findings. Matching values are never printed.')
    return bool(problems)


if __name__ == '__main__':
    sys.exit(main())
