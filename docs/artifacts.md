# Immutable outgoing artifacts

Main replies, worker results and `send_voice` prepare private copies of ordinary
files before the final response transaction. The service allocates a UUID, stores
bytes in `state/outbox-artifacts/UUID` and commits an `artifacts` inventory row
containing SHA-256, size, MIME, original filename, owner, conversation, session,
actor and creation time. Files are synced before the inventory is committed.
Storage directories use mode 0700 and files 0600. Existing workspace grants remain
unchanged. The response transaction atomically publishes all outbox references,
job completion and applicable history; it cannot publish only a subset on failure.
Safe unreferenced preparations can remain in inventory after cancellation or a
failed final commit. A failure before inventory insertion may leave an unindexed
file. Retention is indefinite. There is no automatic artifact deletion or GC.

Source changes or deletion after queueing do not change delivery. At send time the
service rechecks the persisted owner/conversation/session/actor binding, opens the
snapshot without following symlinks, checks its identity and bounded size, reads
it once and verifies the SHA-256. Telegram receives those exact buffered bytes;
it never reopens the verified path. Original filenames and MIME survive storage
under UUID names. PNG/JPEG up to 10 MiB use photos with a document fallback using
the same bytes; the outgoing limit remains 49 MiB. Snapshot missing/integrity/route
failures become `failed` before any upload or indicator, never an uncertain remote
send. Lost Telegram responses retain existing `uncertain` semantics. Restart
preserves pending/uncertain snapshots; uncertain deliveries are not replayed.

Ordinary exports reject symlinks in every source component, source identity or
size/time changes during copying, nonregular files, hardlinks, paths outside the
workspace, the service database, operational state/private/profile/auth/credential/
backup trees, hidden path components, managed persona files, credential filenames
and database/key formats. Codex home is excluded when mounted inside the workspace.
The descriptor copy checks source components before and after reading. This is
path and inode validation, not secret-content detection: deliberate copies of
credentials to innocent filenames cannot be identified. Node's portable filesystem
API does not provide an atomic openat directory walk; these checks detect observed
replacement but cannot prove isolation against malicious arbitrary code sharing
the filesystem grant. Prompt policy, modes and directory separation do not create
such isolation. Explicit service-owned `/auth` and `/tdl_auth` challenge payloads
retain their privileged validation/expiration lifecycle and do not enter ordinary
artifact inventory.

## Migration and operator gate

Startup adds `artifacts`, nullable `outbox.artifact_id` and `legacy_state`. Existing pending,
sending or uncertain ordinary path-only rows become `legacy`, with payloads and
source files retained; `legacy_state` records their previous delivery state. No enqueue-time hashes or immutable claims are fabricated.
The service does not send legacy rows. Before rollout, inspect the selected
instance's retained legacy entries privately and reconcile uncertain delivery.
An operator may explicitly cancel them or request a newly prepared response after
reviewing the current source. Do not reset their state to pending to bypass this
gate. Existing text and privileged authentication entries keep their lifecycle.

Back up and restore the canonical SQLite database together with the entire
`state/outbox-artifacts` directory. Artifacts are written before their DB reference,
so a later filesystem backup contains each earlier committed snapshot under normal
service writes; same-grant tampering/deletion and concurrent restore are outside
that guarantee. Retained orphan inventory and unindexed files are included too.
A stopped-instance restore must verify referenced hashes before enabling delivery.
Missing or mismatched files fail closed. No private artifact bytes enter source.

Source rollback requires stopping delivery first: older code does not understand
artifact verification and would reopen snapshot paths without integrity checks.
Preserve snapshots, legacy rows and the additive table. Use a consistent pre-upgrade
workspace/database backup for full rollback, and reconcile later sends to avoid
replaying an already delivered message. See [backups](backups.md) and
[deployment](deployment.md) for operational gates.

`test/artifacts.test.js` uses synthetic files to cover source change/delete,
restart, symlink swap, hardlink aliases, sensitive exports, tampering, route
mismatch, original worker sessions, final COMMIT rollback, storage modes and
buffered photo fallback. Tooling/voice/reliability/conversation tests cover the
surrounding service contracts. Real Telegram playback, deployment and backup
restore remain separately authorized acceptance gates.
