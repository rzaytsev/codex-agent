# Optional encrypted host backups

The Linux host can run Restic independently of agent reasoning. Each configured
instance has a separate repository, password and hourly systemd timer. This
source does not imply that backups are installed on your host.

## Configure and install

Copy examples/backups.json to private/operations/backups.json. Set the absolute
source checkout, repository root, password root, state root, Restic executable
path and explicit instance list. Keep existing values when migrating an installed
backup system; changing a repository path does not move its data or key.

On an authorized x86_64 Linux host, as root:

```sh
python3 scripts/install-agent-backups.py --config private/operations/backups.json
```

This is a host mutation: the installer downloads the current official Restic
release, checks its SHA256 checksum, preserves existing repositories/passwords,
installs /usr/local/sbin/codex-agent-backup and systemd units, and writes protected
settings to /etc/codex-agent/backups.json. It enables and starts only configured
instances. No credentials are copied into source. Existing timers for removed
instances are not silently deleted; review them during reconfiguration.

## Coverage and consistency

The job resolves the chosen container through bin/agent and inventories its real
bind/volume mounts. It includes workspace, Codex authentication, mounted skills,
optional source trees, the whole private instance directory, base Compose file
and backup settings. Source trees can be large. Overlapping roots are scanned
once; tmpfs is omitted. Missing roots and repository/source overlap fail the job.

Python's SQLite online backup API saves a consistent database under the configured
state root at NAME/assistant.sqlite, and checks it before backing up. The live
main database, WAL and SHM are excluded. A private manifest identifies mount paths
and the database restore destination. Other files are a live filesystem backup,
not a simultaneous snapshot. Bots are not paused.

After a complete backup, retention keeps one month of snapshots and prunes
unreferenced data. Incomplete/failed backups do not trigger retention. Root-only
keys live separately from repositories; protect an independent copy. A backup
on the same disk does not protect against disk or host loss.

## Inspect and restore

```sh
systemctl list-timers 'codex-agent-backup@*.timer'
systemctl start codex-agent-backup@demo.service
journalctl -u codex-agent-backup@demo.service --since today
```

Receipts and private detailed logs live under state_root/NAME. Select the matching
RESTIC_REPOSITORY and RESTIC_PASSWORD_FILE privately for restic snapshots/check.
Restore into a separate directory first. Verify the manifest and SQLite integrity.
While the intended instance is stopped, restore its workspace, Codex state and
private configuration, then install the consistent database as
workspace/state/assistant.sqlite without old WAL/SHM files. Review shared source
restores separately to avoid replacing another instance's files.

Starting a restored bot can resume deliveries; do not launch a second copy of an
active bot. A full restore drill on the deployment host is an acceptance gate.
The local tests cover snapshot consistency, config selection and mount checks.

References: [Restic releases](https://github.com/restic/restic/releases),
[retention](https://restic.readthedocs.io/en/stable/060_forget.html),
[restore](https://restic.readthedocs.io/en/stable/050_restore.html).
