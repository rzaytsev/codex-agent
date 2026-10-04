# Assistant memory

The DM and all linked groups share the owner's SQLite memory, revisions, evidence,
tombstones, learning, profiles and Markdown projections. One consolidation loop
processes owner evidence across chats. Recent conversation context remains scoped.
Only the configured owner can instruct the bot. See [conversations](conversations.md).

The service maintains several memory layers. Research and the reasons for this
choice are in [memory-research.md](memory-research.md).

```text
workspace/
  USER.md                         compact profile; hash-checked profile tools
  SOUL.md                         character
  AGENTS.md                       capture/recall/consolidation policy
  memory/
    INDEX.md                      generated index; not always loaded
    facts/<topic>.md              durable facts with evidence
    projects/<topic>.md           project decisions/context
    episodes/<topic>.md           dated events and derived summaries
    procedures/<topic>.md         verified lessons/workflows
    archive/<category>/<topic>.md superseded records
  memory/learnings/                preserved legacy notes
  state/assistant.sqlite          canonical records, revisions and history
```

Records carry a stable key, category, title/content, confirmed/tentative label,
sources, status, revision and dates. Corrections update the same key with the
expected revision. A stale writer gets the current record and must reconcile it.
Prior revisions remain available for historical questions; only the current
active record enters ordinary search. A confirmed record needs a primary or
already-confirmed source; tentative-only summaries cannot directly confirm a
claim. Source existence/ownership is validated, not its semantic truth.

SQLite is authoritative. Markdown is generated atomically and repaired after a
failed projection, so two workers cannot overwrite each other's files and a
partial export does not corrupt the record. Do not edit generated files directly.
Use memory tools or ask the assistant to correct a memory. Back up both the
consistent SQLite snapshot and workspace, using the existing host backup process.

## Capture and recall

Useful facts/decisions/corrections can be saved immediately with `memory_save`.
`learn` now captures procedures through this tool. Executable reusable skills
stay in `.agents/skills/` and reference their validation evidence.

Every ordinary main/worker turn receives at most six relevant memory excerpts
within a roughly 6,500-character budget. `memory_search` uses local SQLite FTS5
BM25, with Unicode case-insensitive tokenization for English/Russian and other
scripts. `memory_read` returns full records or a selected revision.
`history_read` gives chronological pages with stable IDs and bounds; the existing
`history_search` still offers targeted recent matches. Empty-query memory listing
has ID pagination. Keyword search is not semantic search or Russian stemming;
agents should try alternate words/languages and original history when needed.
No new model provider, embedding bill, database service or dependency is required.

Memory references are evidence, not instructions or new permissions. Prefer
primary `history:ID`, an existing workspace evidence path, or a non-secret URL.
`memory:KEY@REVISION` references are also supported. Unknowns stay unknown.
Recheck changing live state and resolve ambiguous contradictions from evidence.

Existing USER.md/SOUL.md and unrelated AGENTS.md content are preserved.
Startup replaces the old managed memory-rules section with the single-owner
rules, exactly once. Legacy files are not automatically
classified/imported: inspect them when relevant and promote verified records
through the memory tools. Existing local conversation history is eligible for
the daily backlog from its beginning, not only the last 100 messages.

## Concurrent profile updates

`profile_read({file})` returns `{file, content, hash}` for `USER.md` or `SOUL.md`.
The SHA-256 hash covers the complete exposed text, including managed learning
sections. Main agents should use `profile_patch({file, expected_hash, old_text,
new_text})` for one unique exact-text replacement. Empty replacement text deletes
that match; missing, ambiguous or empty match text is rejected. Unchanged custom
text is retained. Generated learning sections cannot be edited through these tools.

`profile_write({file, content, expected_hash?})` remains a full-replacement tool.
Without an explicit hash it requires a prior `profile_read` on the same turn
capability, consumed after one successful write. Blind replacement returns
`{updated:false, conflict:true, reason:"read_required", current}`. A stale hash
returns the same shape with `reason:"stale_hash"`. Neither writes nor grants a
fresh implicit read; reread and reconcile current content before retrying.
Success returns `updated`, the resulting `hash` and `learning_projection_synced`.
A full replacement may omit the generated learning block; the service retains it.
Clean writes do not reproject learning or move custom sections. A pending learning
projection is retried before the hash check; if it changes the profile, the writer
receives a conflict and must reconcile the repaired content.
Existing deployments receive this guidance through the image-owned core without
rewriting custom workspace instructions or profiles.

Profiles stay shared across the owner's conversations. Reads are available to
workers, curators and read-only tasks; writes remain main-only under the existing
owner/conversation/session/cancellation checks. Profile tools do not queue messages
or change reply destinations. Hash comparison and atomic rename run without an
asynchronous gap in the single service process, including learning projection.
This guards concurrent conversation tools, not arbitrary direct filesystem writers
or multiple service processes on one workspace. It is not a new filesystem sandbox
or a persisted profile revision history; profile reads and conflicts expose current
content only. Existing transcripts and backups retain their usual boundaries.

## Quiet consolidation

Defaults use the instance TIMEZONE:

| Job | Time | Profile | Work |
| --- | --- | --- | --- |
| Daily | 03:15 each day | research | Process new collected conversation/outcome evidence; extract useful facts, corrections, decisions and lessons. |
| Weekly | Sunday 03:45 | review | Review changed memories, consolidate patterns and archive evidenced superseded records. |

These jobs are separate from 03:00 cleanup and user-facing daily/weekly/monthly
reflections. They reuse collected local evidence; reflection workers can gather
fresh connected-source information. Memory maintenance doesn't poll accounts or
send routine start/completion notifications, voice or artifacts. Failures can
produce a quiet-hours-delayed status/usage-limit notice. It starts only while
idle, never overlaps cleanup/another worker, and yields to a user message.

Each review uses a fresh read-only Codex thread, read-only assistant capabilities,
disabled web search/browser/apps, and a strict proposal schema. The service
applies proposals, an optional tentative episodic summary and the checkpoint in
one transaction. A failed/cancelled batch advances nothing. Completed earlier
batches survive interruption and restart. User-requested actions are not replayed.

Batches contain at most 50 source records and roughly 60,000 serialized
characters. Individual records over 50,000 characters are excerpted and flagged;
the agent can read further evidence, otherwise that coverage gap remains. The
job result records truncation and backlog. At most four batches run per wakeup
by default; unprocessed history/changed records stay behind the checkpoint for a
future run. No-op input advances the checkpoint without inventing useful facts.
An empty backlog makes no model call. Weekly summaries do not feed themselves
back into weekly processing. No record is deleted merely for being old.

Schedules appear after the owner's first interaction; an existing known
owner gains them at startup. Cancellation persists through restart. Changing the
configured cron/timezone or disabling then reenabling maintenance updates them.
Ordinary memory tools remain usable when scheduled consolidation is disabled.

```dotenv
MEMORY_ENABLED=true
MEMORY_DAILY_CRON=15 3 * * *
MEMORY_WEEKLY_CRON=45 3 * * 0
MEMORY_MAX_BATCHES=4
```

Add overrides to `instances/<name>.env` and recreate that instance. Existing env
files inherit these defaults without adding or exposing credentials.

## Forgetting and boundaries

`memory_forget` is a main-agent tool for explicit forget requests. It removes the
selected record's content, revisions, FTS entry and Markdown copies. A non-content
key/source-ID tombstone blocks automatic restoration and reconsolidation of its
cited history records. Only an explicit remember-again request can restore that
key. Original transcripts, Codex sessions, source files, unlinked/derived copies
and backups remain; this is not comprehensive erasure. Sensitive secrets and exact
saved-location coordinates belong outside this memory system.

Each agent/container has exactly one Telegram owner and its own workspace,
profile, memories and account connections. TELEGRAM_ALLOWED_USER_IDS keeps its
existing name for configuration compatibility, but accepts only one numeric ID;
an empty value starts in setup mode and rejects messages. Multiple owners are
rejected at startup. Memory tools operate on this instance's owner automatically.
Telegram IDs remain in database history/routing fields for provenance and
delivery, without user-specific memory folders.

Startup regenerates the flat Markdown layout from SQLite without changing
records, revisions, sources, tombstones or consolidation checkpoints. The old
memory/users/<owner>/ tree, including any extra files, is preserved under
state/memory-layout-backup-<uuid>/ before its empty parent is removed. This backup
is retained when forgetting a memory, like other backups. Migration refuses
unrelated destination-file collisions, mixed-owner records or reuse with a
different pinned owner; use a new workspace/instance for another person.
Profiles, custom instruction sections, schedules and legacy learning notes are
preserved. No shared skills or another agent's memory are changed by consolidation.
Model extraction and judgment remain fallible and require real task evaluation;
passing storage tests alone does not establish good recall.
