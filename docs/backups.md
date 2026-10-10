# Optional encrypted host backups

With [agent messaging](agent-messaging.md), instance snapshots include local mail
tables. The separate broker database and private identity config require their
own consistent backup; existing per-agent mount inventory does not include them.

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
main database, WAL and SHM are excluded. The canonical snapshot contains all active chats.
Retained legacy conversation DBs also receive online snapshots under
NAME/conversations/ID/; their live SQLite/WAL/SHM files are excluded. New chats
have no separate DB. Obsolete executor sockets remain excluded. A private manifest retains the legacy database_restore
entry and lists every snapshot/destination in databases_restore. Other files are a live filesystem backup,
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
workspace/state/assistant.sqlite without old WAL/SHM files. Restore every group
database listed in databases_restore to its recorded destination in the same
way. Legacy recovery copies are independently consistent; active chats share the canonical snapshot.
Review shared source
restores separately to avoid replacing another instance's files.

Starting a restored bot can resume deliveries; do not launch a second copy of an
active bot. A full restore drill on the deployment host is an acceptance gate.
The local tests cover snapshot consistency, config selection and mount checks.

References: [Restic releases](https://github.com/restic/restic/releases),
[retention](https://restic.readthedocs.io/en/stable/060_forget.html),
[restore](https://restic.readthedocs.io/en/stable/050_restore.html).

## Task and schedule admission migration

Startup creates the additive `admissions` table and its composite primary key;
existing jobs, metadata, schedules, state and IDs are preserved. There is no
backfill of old keyless jobs because their request identity was never captured.
An existing keyed user schedule is adopted only on a matching retry. Ledger rows
are durable audit data: do not prune them or cascade-delete them during task,
schedule or workspace cleanup. They store fingerprints and original responses,
not a second copy of task prompts. Back up this table with the authoritative
SQLite database; online snapshots retain both resource and admission records.

Back up before upgrading. A source rollback can leave the additive table in place;
older code ignores it and loses conflict/idempotent-retry enforcement for new
calls, while existing jobs/schedules still work. Do not keep admitting requests
with an older version and then assume the ledger covers those writes. For full
state rollback, stop the instance and restore the consistent pre-upgrade database
using the procedure above, accepting that later admissions and delivery state
will also revert. Never combine a ledger from one snapshot with jobs from another.

## Scheduler occurrence audit

The canonical online SQLite snapshot retains schedule policy/goal intent and
state, job occurrence links, schedule_occurrences (including coalesced/suppressed
or skipped ranges), schedule_goal_receipts and source owner history. Keep these
with jobs, admissions, conversations and sessions; do not delete/cascade audit
through cleanup. Existing workspace/auth backup coverage is unchanged. Synthetic
snapshot tests compare exact restored policy/occurrence/goal receipts.

Back up before upgrading and stop the service before restoring. Source rollback
can leave additive columns/tables but older code cannot enforce new policies,
bounds or owner receipts; do not continue new-policy schedules under it. Reconcile
queued work and uncertain sends first, or restore the matching pre-upgrade
database/workspace snapshot while stopped, accepting loss of subsequent state.
Never combine occurrence/goal audit from one snapshot with jobs from another.

## Immutable outbox snapshots

The canonical database contains artifact inventory and outbox references. The
existing workspace backup also covers `state/outbox-artifacts`, including pending,
uncertain, sent and orphan files. Retention of local artifacts is indefinite;
backup retention does not authorize deleting them. Preserve the whole directory
and restore it with the matching consistent database while the instance is stopped.
Snapshots are synced before DB publication, but the filesystem backup is still
not simultaneous with arbitrary same-grant modifications. Verify every referenced
hash before restart; missing/tampered files fail locally. Source rollback to older
code requires stopping delivery and reconciling queued snapshots because it cannot
verify hashes. Legacy path-only rows remain an explicit operator gate; never invent
old hashes from current source files. See [artifacts](artifacts.md).

## Private observations

The existing online SQLite snapshot includes observation receipts, tenant-local
run relationships and usage baseline state. Back up the existing workspace and
database together; no additional mount or collector is introduced. Restored or
restarted processes invalidate retained token baselines and close open receipts
as recovered interruption with unknown usage/timing. See
[observations](observations.md) for additive migration and rollback.

## Action approval snapshots

The canonical SQLite snapshot includes private action_approvals payloads, consent
bindings and mail_outbox linkage. Retain/restore them together; do not prune audit
rows. Existing workspace/auth coverage is unchanged. Source rollback requires
stopped delivery and pending/uncertain reconciliation because older source lacks
exact confirmation and conservative remote recovery. See
[action-policy migration](action-policy.md#migration-backup-and-rollback).


## Task outcome migration and rollback

Task 7 adds nullable jobs.goal_outcome JSON and durable cancel_requested inputs/jobs. Existing admissions, receipts and content remain. Back up matched SQLite/workspace/artifacts/profiles/Codex home with the exact revision before upgrading. Stop and reconcile processes/effects before rollback; restore the matched pre-upgrade backup and source/image together, retain audit evidence, and never replay uncertain work. Source-only downgrade can misinterpret requested cancellation. See [migration and rollback](task-outcomes.md#migration-and-rollback).

## Known source metadata

The additive history_origins.known_quote and provenance_version columns default
to zero for retained rows, without inferring old quote boundaries or changing
revisions/origins. Version 0 is unknown attribution and cannot authorize new owner
adaptations; existing active records and receipts remain audit. New quote-aware
host intake writes version 1. Existing
consistent SQLite snapshots retain this host metadata; no new mount is required.
Source-only downgrade to the pre-Task-8 base is incompatible: its three-value
history_origins insert fails against the expanded table, breaking owner
intake and potentially leaving history without origin outside a transaction.
Stop/reconcile processes and uncertain effects, then restore matched pre-upgrade
data and source/image together, retaining audit evidence. A separate compatibility
rollback requires design/verification that preserves quote provenance/audit; do not
casually delete metadata columns. Restore loses subsequent writes and cannot undo
external effects. See [runtime migration](runtime-contracts.md#migration-and-rollback).

## Research dossiers

Canonical online snapshots retain all `research_*` tables, source text, revisions
and reviews. Existing workspace backups cover `tasks/<id>/report-<revision>` and
immutable outbox artifacts. Preserve matched database/files through cleanup and
restore. Original fetched response bytes are temporary; retained extracted source
text is authoritative. The old runtime cannot execute queued deep tasks: stop and
reconcile them before downgrade, retain additive data for forward recovery, and
never replay interrupted research automatically. See [research](research.md).
