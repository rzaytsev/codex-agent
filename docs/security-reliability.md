# Security and reliability

This service is a personal automation runtime with substantial account and
filesystem access. Its strongest practical boundary is a separate container,
workspace and Codex home for each owner. Read this alongside [architecture](architecture.md),
[privacy](privacy.md), [deployment](deployment.md) and [backups](backups.md).

## Trust boundaries

- DM intake requires the configured owner with matching sender and recipient.
  Groups require direct owner linking and an addressed message from that same owner.
  Knowledge, profiles, files and tools are shared; recent context and routes remain
  scoped. Other participants are rejected before saving/downloading. Replies are
  visible to group members. Check owner, source conversation, session, task and role
  at service boundaries and active source route at delivery. See [conversations](conversations.md).
- Attachments, forwarded text, transcripts, retrieved memory and connector output
  are source data. Original filenames stay in the saved Telegram envelope;
  downloads receive generated names under `inbox/INPUT_ID/attachments/`. They
  cannot overwrite `message.json`, `transcript.txt` or extracted text through a
  supplied filename. Existing attachment paths remain valid.
- Main, worker and memory-curator capabilities restrict service tools. Each
  capability is revoked after its turn, including setup failures. Cancellation
  propagates to active service-tool work. Curator proposals are validated and
  committed by the service; they are not direct memory database writes.
- Main/worker/curator service roles do not isolate generated code from other
  granted files or credentials inside the owner's container. DM and group turns
  deliberately share that access. Conversation scoping is a routing/context
  contract, not a security sandbox. The filtered environment reduces accidental
  inheritance; it is not a secret vault against code with filesystem access.
- Browser contexts are isolated between turns, but Chromium runs without its
  sandbox inside the container. This is session isolation, not a separate
  operating-system security boundary. Persistent browser login is not implemented.
- Optional MCP servers/plugins inherit their own configured authority. Curator
  settings disable normal apps, browser and web access, but do not prove that
  every separately installed MCP server is inaccessible. Audit account grants
  and server behavior before trusting that boundary.

Do not mount the Docker socket, all private configuration, or unrelated host
directories. Public skills are read-only; private learning remains in the selected
instance. The source-access helper grants only container-root read/search access,
preserves other effective ACL permissions and requires a private rollback snapshot.

## Failure and cancellation contracts

Inputs, jobs, schedules and outgoing messages are durable SQLite records. On
restart, interrupted execution is visible rather than blindly replayed. Outgoing
delivery is not exactly once: a lost or malformed Telegram response may follow a
successful remote send. Such sends become `uncertain` and are not retried
automatically. Valid rate-limit responses retain bounded retry handling.

`/stop` cancels the main turn during media preparation, model execution and final
voice generation. Capability revocation also aborts in-flight voice tools. Downloads
are bounded, cancellation-aware and written through temporary files; failed voice
generation removes partial output. Original files downloaded before a later
extraction/transcription failure remain available.

The service prepares a final response before committing all its delivery entries
and assistant history in one SQLite transaction. Cancellation before that commit
does not leave a partial response queued. This does not undo external actions,
individual tool outputs already committed, or messages already delivered. Artifact
paths in the outbox reference files; they are not immutable snapshots of file bytes.

Quiet hours filter proactive messages before the delivery batch limit, so a backlog
does not block requested replies. Ineligible maintenance jobs do not consume worker
slots. Eligible jobs retain creation order; maintenance remains idle-only and yields
to intake. Long command responses use the same Telegram text chunking as other output.

## Scheduling and storage

All configured cron expressions are validated at startup as five-field expressions
with a next occurrence in the instance timezone. Reflection schedules reconcile
changed cron/timezone settings on startup and owner intake. Disabling proactivity
disables its schedules and prevents queued reflection jobs from starting. It does
not undo a running review or remove already queued notifications. An explicitly
cancelled schedule stays cancelled when configuration is unchanged; changing its
configuration or re-enabling proactivity deliberately restores it.

Additive SQLite indexes cover pending inputs, job selection/status, due schedules,
pending delivery and owner history. They avoid repeatedly scanning completed inputs
as history grows. Index creation is idempotent and preserves all table data; the
first start with a large existing database may take longer to create them.

## Verification and limits

`test/media.test.js`, `test/agent-lifecycle.test.js` and `test/reliability.test.js`
cover hostile filenames, malformed Telegram envelopes, download bounds,
cancellation at asynchronous boundaries, capability cleanup, transactional output,
quiet-hour backlog, scheduling and worker capacity. Existing tests cover owner
checks, memory revisions/provenance, recovery, instance separation and backups.
`test/backups.py` checks conservative ACL changes and wrapper argument handling.
See [development](development.md) for commands and the full validation ladder.

The 2026-10-02 source review reproduced and fixed one low-severity attachment
filename collision that could overwrite saved forward provenance. The npm advisory
audit on that date returned no known vulnerabilities. Neither result establishes
that every dependency, generated program or remote service is safe. Installed
Python/OS packages, optional MCP implementations and actual account permissions
need separate runtime review. A source review and synthetic tests also cannot prove
model behavior, production health or successful Telegram delivery.

Before rolling out changes, build and test the target image with synthetic data,
back up the selected instance, preserve its Compose project and data mounts, then
recreate one instance at a time. Verify readiness and preserved state, followed by
an authorized real interaction. HTTP liveness alone is not proof that model login,
Telegram delivery or every optional connector works.
