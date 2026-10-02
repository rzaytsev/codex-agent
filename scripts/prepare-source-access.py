#!/usr/bin/env python3
"""Grant container UID 0 read/search without broadening other effective ACLs."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile
import time
import re




def bits(value):
    return sum(bit for letter, bit in [('r', 4), ('w', 2), ('x', 1)] if letter in value)


def permissions(value):
    return ''.join(letter if value & bit else '-' for letter, bit in [('r', 4), ('w', 2), ('x', 1)])


def grant(block):
    lines = block.splitlines()
    escaped = next(line[8:] for line in lines if line.startswith('# file: '))
    file = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), escaped)
    owner = next(line[9:] for line in lines if line.startswith('# owner: '))
    access = {}
    for line in lines:
        if line.startswith(('user:', 'group:', 'mask:', 'other:')):
            key, value = line.split(':', 2)[:2], line.split(':', 2)[2].split()[0]
            access[':'.join(key)] = bits(value)
    original = dict(access)
    required = 5 if os.path.isdir(file) or access['user:'] & 1 else 4
    if owner == '0':
        if access['user:'] & required == required:
            return None
        access['user:'] |= required
    else:
        mask = access.get('mask:', access['group:'])
        # A new/expanded mask must not unmask permissions for other identities.
        for key in access:
            if key.startswith(('user:', 'group:')) and key != 'user:':
                access[key] &= mask
        access['user:0'] = access.get('user:0', 0) | required
        access['mask:'] = mask | required
    if access == original:
        return None
    headers = [line for line in lines if line.startswith('#')]
    defaults = [line for line in lines if line.startswith('default:')]
    result = headers + [f'{key}:{permissions(value)}' for key, value in access.items()] + defaults
    return '\n'.join(result) + '\n\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot-dir', type=Path, required=True)
    parser.add_argument('roots', nargs='+')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Run on the Linux Docker host as root')
    roots = [str(Path(root).resolve()) for root in args.roots]
    if '/' in roots:
        raise SystemExit('Refusing a whole-host ACL change')
    for root in roots:
        if not Path(root).is_dir():
            raise SystemExit(f'Missing source root: {root}')
    saved = args.snapshot_dir
    saved.mkdir(parents=True, exist_ok=True, mode=0o700)
    original = saved / f'before-{time.time_ns()}.acl'
    count = 0
    with original.open('x') as before, tempfile.TemporaryFile(mode='w+t') as after:
        original.chmod(0o600)
        process = subprocess.Popen(['getfacl', '-R', '-p', '-n', '-P', *roots], stdout=subprocess.PIPE, text=True)
        block = ''
        for line in process.stdout:
            block += line
            if line.strip():
                continue
            changed = grant(block)
            if changed:
                before.write(block)
                after.write(changed)
                count += 1
            block = ''
        if process.wait() != 0 or block:
            raise SystemExit('ACL inventory failed; no changes applied')
        after.seek(0)
        subprocess.run(['setfacl', '--restore=-'], stdin=after, check=True)
    print(f'Read access prepared for {count} source entries; previous ACLs saved privately.')


if __name__ == '__main__':
    main()
