# Continuous learning

The assistant improves its assistance through sourced, scoped, reversible learning.
Records and rules are shared across owner chats; one review loop processes their
evidence. Its mission is to help the owner pursue their chosen goals, reduce avoidable effort
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
| Scoped operating lesson | PLAYBOOK.md or managed AGENTS.md section | New/changed rules start as trial. Active requires a later host outcome receipt for the unchanged trial. |
| Explicit preference | Managed USER.md section | Original owner statements, active; inferred preferences are rejected. |
| Explicit interaction style | Managed SOUL.md section | Original owner preference/correction, active; major role changes need conversation. |
| Useful missing constraint | PLAYBOOK.md | Pending, offered once, then resolved or retired from original evidence. |

Goals and commitments remain sourced project memories. Executable procedures and
skills retain their existing validation rules; a learned instruction is not proof
that a procedure works. Main profile_write and profile_patch tools support
hash-checked owner-driven edits. Pending learning projection is repaired before
the hash check; clean managed sections are preserved without reprojection.
See [concurrent profile updates](memory.md#concurrent-profile-updates).

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
A model validation pass is not measured improvement and cannot mint an outcome receipt. The evaluator's semantic
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

Explicit structured-memory forgetting marks learning records citing blocked
history IDs for review, retains their content and revisions, cancels pending
linked questions and removes them from ordinary context/projections. Review
receipts, original transcripts, sessions, derived copies and backups remain.
This is not comprehensive erasure; see [shared evidence](#forgetting-shared-evidence).

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

The [held-out quality suite](memory-quality-evals.md) adds uncoached extraction,
fresh-task transfer, provenance checks and rollback observations. Its fake-adapter
tests verify the harness only; real subscription runs are opt-in and require
review of individual results before any learning-quality claim.

## Forgetting shared evidence

When structured forgetting blocks a history ID, learning records citing that ID
are retained with `review_state=needs_review`, including historical revisions.
Shared source IDs do not prove that every fact in the message is the same fact.
These records leave ordinary context and managed profile/playbook projections;
pending associated questions are cancelled and no new offers use them. Explicit
`learning_read` inspection remains available. Original history, delivered or
uncertain messages, learning review audit rows and backups remain. Use
`memory_forget_preview` to inspect the impact; it cannot enumerate unlinked copies.

Current learning selection filters retained `needs_review` records out before
capacity checks and bounded selection. The same selector supplies context,
profile/playbook projection, pending question offers and automatic learning-review
prompts. Historical retention does not consume the 40-current-record allowance or
crowd independent current lessons out of the first 100 candidates. Explicit
`learning_read` by key or revision remains available for inspection.


## Host outcome receipts and authority

New trial-to-active promotions require a host-owned `improved` receipt tied to the
trial revision, SHA-256 candidate hash and hash of its preselected `check`.
`learning_read` returns these hashes, the check and revision-specific
`outcome_receipts`. The check and trial evidence cursor are stored before any
outcome. Receipts carry observation time, genuinely later owner-bound history/job
evidence IDs, authority, and optional verified terminal run/attempt IDs. Original
trial sources, stale revisions/hashes, changed checks, blocked evidence and
unknown/foreign/mismatched observation IDs are rejected. `inconclusive` leaves a
trial unproven; any `regressed` receipt blocks promotion of that revision even if
another receipt says improved. Proposals still need independent validation.

The host records explicit owner outcomes through the exact command:
`/learning_outcome KEY REVISION CANDIDATE_HASH improved|inconclusive|regressed`.
Inspect the trial/check through `learning_read` first. Only authenticated direct
owner DM text can supply this authority. Hidden/legacy forwarding fields, automatic
forwarding, via-bot content, attachments, groups, assistant/peer/event/job sources
and model-supplied origin never grant direct owner preference or outcome authority.
A trusted deterministic host check may use `Learning.recordOutcome` after checking
the result; this interface is absent from both MCP and direct action registries.
A successful job or `accept=true` is insufficient. This does not stop arbitrary
code with the process's same filesystem grants from bypassing service APIs.
Full credential/foreign-task isolation remains **incomplete and blocking**.

Host intake adds bounded `history_origins` metadata. `role=user` alone, including
legacy/imported rows without attribution, is `legacy_unknown` for new learning
authority. Genuine new owner preferences/styles can be adopted directly without an
experiment. Authenticated group facts remain usable memory evidence, but do not
supply direct-DM preference or outcome authority. Arbitrary pasted quote semantics
are not inferred by regex; semantic support is still a review judgment.

Startup adds `history_origins`, `learning_trial_bindings` and `learning_outcomes`
without changing existing active rules/preferences, profile text or revisions.
Legacy trials have no preselected binding receipt: reaffirm/revise them as a new
trial before an outcome can promote them. Back up the consistent SQLite snapshot
and workspace with the existing [backup process](backups.md). Rollback retires the
application while retaining receipts, previous revisions and review audit. Source
rollback to an older image leaves additive tables intact but removes the new gates;
use a pre-upgrade backup only for deliberate whole-state restoration, which loses
subsequent writes. No migration deletes records or authentication.
