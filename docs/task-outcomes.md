# Task outcomes and cancellation settlement

Execution state and goal outcome are separate. A `completed` worker finished its
execution and committed its response, but its goal can be `achieved`, `partial`,
`blocked` or `unknown`. An optional final `outcome` has `status`, `checks`,
`evidence` and `limitations`; an optional `checkpoint` has `plan_version`,
`last_verified_milestone`, `next_safe_step` and `unresolved_effects`. Each list is
bounded to 16 strings of at most 2,000 characters; checkpoint version is an integer
from 1 through 1,000,000. Unknown fields and invalid types fail closed. Null/absent
fields support legacy replies. The provider response schema requires both nullable
fields; new model replies use `null` when no metadata is reported. This satisfies
the [Structured Outputs requirement](https://platform.openai.com/docs/guides/structured-outputs#all-fields-must-be-required)
that every property be required, while retained legacy results may omit them.
These records contain private task content, never
telemetry payloads.

The service validates shape, then atomically stores the model-reported outcome and
returned checkpoint with the completed job and response queue. `host_verified`
is always false, even for a claimed achieved goal or a named verified milestone.
Shape checks, model reports, host verification, delivery and owner acceptance are
different evidence. Legacy replies have unknown goals. No generic host verifier
or automatic second reviewer is installed. Existing opt-in `review` tasks are a
path for a meaningful deliverable: supply the artifact, acceptance criteria and
permitted checks, then inspect the returned checks/evidence/limitations. Such a
review is still model-reported and does not mint learning or schedule authority.
Ordinary replies use one model turn.

`task_status` lists the latest 30 scoped jobs by default. With `{id: TASK_ID}` it
retrieves at most one exact task and its full stored outcome/checkpoint, even beyond
that list. Owner/conversation scope still applies; absent or foreign IDs return
an empty list. `/status` shows execution
state, goal, reporting authority and fresh-owner-intent requirement. Returned
checkpoints survive restart; intermediate model progress that was never returned
and committed is not invented. There is no resume/retry command and no automatic
replay. Reconcile uncertain external effects and request new work with explicit
fresh owner intent. An idempotent admission key does not authorize replay.

## Cancellation and owned processes

Queued work cancels immediately. Running work first persists `cancel_requested`,
then aborts its capability and execution signal. `/cancel` reports requested versus
settled cancellation truthfully. Requested work reserves worker and global
execution capacity and participates in scheduler overlap checks until settlement.
`/stop` applies the same contract to the active main input. Files and voice are
prepared before the response transaction; cancellation during preparation commits
no partial final text, files, voice or assistant history. Already committed tool
output, delivery or external effects cannot be undone.

The pinned 0.159.2 SDK's early generator return can remove process listeners and
return while a SIGTERM-ignoring CLI remains alive. `supervised-exec.js` replaces
only its subprocess adapter, retaining SDK threads, schema files, parser and native
model/tool loop. It checks the pinned integration shape and supports the selected
Linux/macOS runtime. Synthetic differential tests compare argv, TOML config,
environment, schema and input, including resumed threads and the restricted
prototype's absence of a legacy sandbox override. The adapter uses the SDK's
resolved executable/path directories and the same selected environment. It adds
no account, filesystem or network grants. Dependency versions are unchanged.

Owned SDK and media helpers run in their own process group. Cancellation sends
SIGTERM, escalates to SIGKILL after 250 ms and waits for the owned child's actual
exit event. If stdout ends before the child exits, forced cleanup remains a
non-success even after a model completion event; an observed exit releases
capacity, and only missing proof after cleanup is unknown. Media stdout remains
bounded; subprocess stderr is discarded and failure diagnostics are fixed. Service-tool media work is tracked through its
logical run so releasing the capability also drains its owned helpers before
settlement. Shutdown awaits main/worker promises instead of exiting after an
unconditional two-second timer. Timeout and budget observation reasons remain
separate from owner cancellation. `execution_unknown` is a fixed observation
reason when exit proof is unavailable; it contains no process identifiers or text.

This is proof of the owned child's exit, **not full native process-tree isolation**.
Same-group descendant signals are best effort; detached/escaped descendants,
remote work and previously performed effects remain unverified. Native tools,
authenticated runtime compatibility and full Linux/macOS filesystem/process
containment gates remain **INCOMPLETE AND BLOCKING**. Synthetic parser/executable
fixtures are not model/account/deployed acceptance. No real model or Telegram
calls are needed for these tests.

If bounded cleanup cannot observe exit, the promise settles with an unknown
execution error, the durable task/input remains `cancel_requested`, publication
is suppressed, and capacity stays reserved. After a process crash/restart,
previous `cancel_requested` rows also remain requested with unknown exit/effects;
empty controller maps are not proof of stopped execution. Skip overlap still
skips, coalesce retains only its queued continuation, and no affected task is
replayed. This can intentionally block capacity indefinitely. An operator must
stop the instance, prove the relevant runtime/processes stopped, reconcile effects,
and preserve an audit/backup before administratively resolving those rows as
interrupted; fresh owner intent is required for new work. Never clear a live row
to gain capacity. No automatic operator reconciliation or manual resume is provided.

## Migration and rollback

Migration is additive: nullable `jobs.goal_outcome` stores version 1 private JSON;
existing rows/results, admissions, schedule receipts and learning authority remain
intact. `cancel_requested` also appears in `inputs.state`; neither state column has
a restrictive enum. Observation reason `execution_unknown` uses the existing
strict content-free schema. No private profile seed is overwritten; the optional
outcome instructions are image-owned and reach existing profiles with an image
update.

Before deployment, stop execution/delivery and take a matched backup of SQLite,
workspace artifacts/profiles, Codex home and the exact source/image revision using
the established backup procedure. Test the upgrade on a disposable copy. For
rollback, stop the candidate and establish process/effect state first, then restore
the matched pre-upgrade database and filesystem backup with its original revision.
Do not downgrade only source against new requested rows: old cancellation code can
misreport them and discard the new contract. Retain post-upgrade audit evidence;
restoring a database cannot undo external sends/actions or authorize replay. See
[backups](backups.md).

Verification: `test/task-outcomes.test.js`, `test/reliability.test.js`,
`test/agent-lifecycle.test.js`, media/voice, scheduler, observations, prompt and
conversation suites. The raw pinned-SDK control shows a live child after early
return; the supervised regression observes actual child disappearance before
settlement. Fixtures own and clean synthetic files/processes; no external endpoint,
authentication, model quota or host security change is involved.
