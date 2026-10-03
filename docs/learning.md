# Continuous learning

The assistant improves its assistance through sourced, scoped, reversible learning.
Its mission is to help the owner pursue their chosen goals, reduce avoidable effort
and develop capabilities they want. It does not choose the owner's goals or treat
silence as approval. Model weights and account permissions do not change.

## Stable core and editable context

Every SDK turn receives application-owned templates/CORE.md after editable
workspace context. The deployed read-only image protects that file from ordinary
workspace edits. Learned content cannot modify it through the service. This is an
instruction precedence and file protection mechanism, not an additional sandbox
for normal full-access turns or their connected accounts.

SQLite owns learning records, revisions, review receipts and coverage. Startup
adds one Continuous learning section to AGENTS.md while preserving custom sections.
PLAYBOOK.md is a generated inspection view. Accepted adaptations targeting AGENTS.md,
USER.md or SOUL.md occupy marked sections only; unrelated content is preserved.
A pre-existing unrelated PLAYBOOK.md or unsafe projection path is left intact and
reported as an export gap. SQLite remains usable; retry after preserving that file
elsewhere. The SDK strips generated sections and supplies bounded relevant records
separately, avoiding loading the whole playbook on every task.

| Kind | Destination | State and authority |
| --- | --- | --- |
| Scoped operating lesson | PLAYBOOK.md or managed AGENTS.md section | New/changed rules start as trial. Active requires later supporting evidence and validation. |
| Explicit preference | Managed USER.md section | Original owner statements, active; inferred preferences are rejected. |
| Explicit interaction style | Managed SOUL.md section | Original owner preference/correction, active; major role changes need conversation. |
| Useful missing constraint | PLAYBOOK.md | Pending, offered once, then resolved or retired from original evidence. |

Goals and commitments remain sourced project memories. Executable procedures and
skills retain their existing validation rules; a learned instruction is not proof
that a procedure works. The main profile_write tool continues to support direct
owner-driven edits and reprojects managed sections after writing.

## Evidence and review

History inserts and terminal ordinary task outcomes produce owner-bound evidence
references. Existing history and terminal jobs are eligible from the beginning.
Memory consolidation, cleanup, learning jobs and reflection output do not feed this
loop as new evidence. Task completion alone does not establish user acceptance.

Configured owners receive a silent learning schedule at startup, including instances
with imported history and no first-conversation marker. Empty backlogs make no model
call. Daily at 03:30 in the configured timezone, a separate idle-only job processes up to
two batches, each at most 50 references and roughly 45,000 serialized characters.
Large history/task fields are excerpted at 12,000 characters and flagged; read-only
history/learning evidence tools can expand them. Editable profile excerpts are
limited to 16,000 characters per file. Remaining evidence stays behind a checkpoint
for the next run. No new evidence means no model call.

A fresh research turn proposes at most five changes. A separate fresh review turn
checks them against original evidence, existing context, scope and observable
checks. Both run read-only, disable browser/web/apps, and have only read service
capabilities. The service validates owner, references, target, revision and states;
accepted updates, rejection audit and checkpoint commit together. Validation or
cancellation failure advances nothing for the unfinished batch. Completed prior
batches survive restart. Rejected candidates are audited but never installed.

New or revised rules are explicitly unproven trials. Later reviews can promote an
unchanged rule when new evidence supports its check, or retire it when harmful.
A model validation pass is not measured improvement. The evaluator's semantic
judgment remains fallible, even though service checks reject malformed references,
foreign owners, forwarded profile authority, obvious secrets and policy-expansion
phrases. Installed third-party MCP servers retain their own grants; disabling apps
and service writes is not a universal connector isolation guarantee.

## Questions, feedback and rollback

At the daily user-facing reflection time, the service offers at most one pending
learning question per local calendar day. Only validated questions enter that
backlog. Each includes why its answer matters. Notifications honor proactivity and
quiet hours. An offer stores its outbox ID and is never automatically repeated,
including after restart or uncertain delivery. It does not prove reading or consent.
No routine learning start/completion notices are sent; failures can produce a
quiet-hours-delayed notice.

The main agent uses learning_read and learning_evidence to inspect original
sources. On explicit owner feedback, learning_feedback with the current revision
can resolve a question, dismiss advice or roll back a rule. Rollback retires the
current rule immediately; earlier revisions remain inspectable. Resolving or
retiring a question cancels its still-pending notification, not an already sent or
uncertain delivery. Retired/resolved records cannot be revived automatically.
Workers and curators cannot use the mutation tool.

For example: repeated requests for a next step support a scoped planning trial.
A later owner report that it saved another correction can support promotion. A
later instruction to stop retires it. Silence leaves usefulness unknown.

Explicit structured-memory forgetting also removes learning records and revisions
that cite its blocked history IDs, cancels pending linked questions and repairs
projections. Review receipts, original transcripts, sessions, derived copies and
backups can remain. This is not comprehensive erasure.

## Configuration and verification

```dotenv
LEARNING_ENABLED=true
LEARNING_CRON=30 3 * * *
LEARNING_MAX_BATCHES=2
```

Learning is independent of MEMORY_ENABLED and PROACTIVE_ENABLED. Disabling learning
stops new learning jobs and ordinary-turn adaptation injection. Existing marked
files remain inspectable. Disabling proactivity prevents new question offers;
already queued notifications retain the existing delivery semantics. Schedule
cancellation persists through restart unless cron/timezone changes or the feature
is deliberately reenabled. Intake interrupts learning; it never delays requested
work to finish a review.

At most 40 live adaptations are permitted and at most eight relevant records enter
a turn within a roughly 6,500-character budget. Historical audit/revisions remain.
This limit bounds instruction growth; the reviewer must retire obsolete learning
before adding more. Selection is lexical, with scope general treated as general.

Run test/learning.test.js and the standard development checks. The optional
scripts/learning-smoke.js uses subscription inference in an empty isolated workspace
with an existing login. It starts no Telegram poller, contacts no user and stores no
real personal content. It checks proposal/validation, restart, a fresh turn and
rollback. Real deployment quality still requires observing actual assistance and
user outcomes; healthy containers do not establish long-term improvement.
