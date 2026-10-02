#!/usr/bin/env python3
"""Install Restic and host backup units for explicitly configured instances."""
import argparse
import bz2
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import urllib.request
import importlib.util

spec = importlib.util.spec_from_file_location('backups', Path(__file__).with_name('backup-agents.py'))
backups_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backups_module)


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'codex-agent-backup-setup'})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or os.uname().machine != 'x86_64' or os.uname().sysname != 'Linux':
        raise SystemExit('Run on an x86_64 Linux Docker host as root')
    os.umask(0o077)
    settings = backups_module.read_settings(args.config)
    source = Path(settings['source'])
    for name in settings['instances']:
        backups_module.instance_files(source, name)
    release = json.loads(fetch('https://api.github.com/repos/restic/restic/releases/latest'))
    version = release['tag_name'].removeprefix('v')
    assets = {asset['name']: asset for asset in release['assets']}
    binary_name = f'restic_{version}_linux_amd64.bz2'
    compressed = fetch(assets[binary_name]['browser_download_url'])
    sums = fetch(assets['SHA256SUMS']['browser_download_url']).decode()
    expected = next(line.split()[0] for line in sums.splitlines() if line.split()[-1] == binary_name)
    digest = hashlib.sha256(compressed).hexdigest()
    if digest != expected or assets[binary_name].get('digest', 'sha256:' + digest) != 'sha256:' + digest:
        raise SystemExit('Official Restic checksum mismatch')
    target = Path(settings['restic'])
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix('.install-tmp')
    temporary.write_bytes(bz2.decompress(compressed))
    temporary.chmod(0o755)
    subprocess.run([str(temporary), 'version'], check=True)
    os.replace(temporary, target)
    passwords = Path(settings['password_root'])
    passwords.mkdir(parents=True, exist_ok=True, mode=0o700)
    backups = Path(settings['backup_root'])
    backups.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in settings['instances']:
        password = passwords / f'{name}.password'
        repo = backups / name
        if not password.exists():
            if repo.exists() and any(repo.iterdir()):
                raise SystemExit('Existing repository has no password; refusing to replace its key')
            password.write_text(secrets.token_urlsafe(48) + '\n')
            password.chmod(0o600)
        if not (repo / 'config').exists():
            subprocess.run([str(target), '--repo', str(repo), '--password-file', str(password), 'init'], check=True)
    script = Path('/usr/local/sbin/codex-agent-backup')
    shutil.copyfile(source / 'scripts/backup-agents.py', script)
    script.chmod(0o750)
    installed_config = Path('/etc/codex-agent/backups.json')
    installed_config.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary_config = installed_config.with_suffix('.json.tmp')
    temporary_config.write_text(json.dumps(settings, indent=2) + '\n')
    temporary_config.chmod(0o600)
    os.replace(temporary_config, installed_config)
    for name in ('codex-agent-backup@.service', 'codex-agent-backup@.timer'):
        dest = Path('/etc/systemd/system') / name
        shutil.copyfile(source / 'systemd' / name, dest)
        dest.chmod(0o644)
    subprocess.run(['systemd-analyze', 'verify', '/etc/systemd/system/codex-agent-backup@.service', '/etc/systemd/system/codex-agent-backup@.timer'], check=True)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', *[f'codex-agent-backup@{name}.timer' for name in settings['instances']]], check=True)
    subprocess.run(['systemctl', 'start', '--no-block', *[f'codex-agent-backup@{name}.service' for name in settings['instances']]], check=True)
    print(f'Restic {version} installed; configured timers enabled and first backups started.')


if __name__ == '__main__':
    main()
