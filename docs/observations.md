# Private logical runs, attempts and cumulative budgets

The application owns these observations in its existing private SQLite database.
They are separable from any future exporter; this change provides none. A logical
run starts before main input preparation or job execution and ends after response
preparation and queue commit. Memory/learning batches and validation calls share
one job run. Each SDK call has a service UUID attempt. Tenant-local run links
connect the generated run UUID to its conversation, job and parent run; these
operational links are separate from content-free receipt payloads.

Schema `schema_version: 1` rejects unsupported versions, unknown fields and
invalid nested fields. Receipts use finite bounded numeric measurements, booleans,
fixed reviewed enums, service UUIDs and SHA-256 digests. Effective model is a digest;
effort, scope and timeout are explicit. Developer instructions and the reviewed
assistant tool bundle have digests; instructions include effective runtime
context, so a changed browser output directory changes the effective prompt hash.
Application release comes from the package manifest, actual Node major/minor/patch
are numeric, and SDK/CLI are pinned to 0.159.2. No raw prompts, arguments, private
thread IDs, tool names, item content/reasoning, URLs, paths, SDK errors, messages or
stacks enter receipts or telemetry logs. Unknown/tenant-defined tools map to
`other`, including names that collide with JavaScript prototype properties.

Terminal attempt/run receipts are idempotent. Reasons distinguish completion,
incomplete stream, quota, deadline timeout, cancellation, provider/parser error,
invalid structured output, recovered interruption, budget and output error.
An SDK attempt can complete while the logical run fails preparing files. Existing
safe partial-output fallback remains; the run then records `output_error`, rather
than successful logical completion. Queue commit does not prove Telegram delivery.
No automatic task replay or schedule change is added. Retry count is zero because
these execution paths do not automatically retry; multiple internal calls are
separate attempts, not fabricated provider retries.

## Usage contract

The actual pinned SDK parser yields `turn.completed.usage` as cumulative
`source: codex_sdk`, `semantics: thread_total`. Persist supported finite numeric
input, output and cached-input components without adding cache input to input.
The pinned parser applies `cache_write_input_tokens ??= 0`, so even a yielded zero
cannot prove a provider measurement existed. Conservatively omit that component
and record `cacheWriteProvenance: unknown_sdk_default` for every receipt pending
raw provenance verification. `supported_complete` describes only the three
supported components; that marker does not make cache-write usage known.

A genuinely new service thread can start with zero baseline. Existing threads
start unknown unless a valid serialized same-process baseline exists. A persisted
thread key is a tenant-salted digest, not the private SDK thread ID. Admission
leases and baseline/terminal writes are transactional and terminal UUIDs deduplicate
receipts. A previously committed attempt UUID is a transaction-wide no-op: the
first receipt wins, including changed-content replays, without consuming a newer
lease or changing run totals/completeness. Only nondecreasing components with a
serialized matching lease produce deltas. Thus fresh 100/20 followed by cumulative 160/30 yields 100/20 plus 60/10.
Failures, missing components, reset/decreasing counters, overlap, restart and
unverified imported threads produce unattributed observations, never negative or
invented deltas. After a gap, a subsequent complete serialized receipt can establish
a new baseline for later calls; its own usage remains unattributed. Overlap requires
another serialized completion before attribution resumes. Run totals are unknown
if any attempt is unattributed or a transactional receipt fails.

Conversation routes open multiple connections to the same database. They share
a process epoch while any registered connection is open, so linking a route does
not recover live runs. When all connections close or the process restarts, invalidate
baselines and recover open attempts/runs once. Recovered timing/counts and usage
remain unknown. No durable private diagnostic text is used as a recovery fallback.

Attribution assumes exclusive application use of its live SDK threads. External
CLI/app reuse cannot be automatically detected by these hooks; imported/reopened
threads are conservative and any known external-use uncertainty must call
`observations.invalidateThread(threadId)` before further admission. External thread
use during a live service epoch cannot be proved safe by a SQLite lease alone.
Do not interpret attributed receipts as proof against unreported external use.

## Budgets and limitations

Optional [configuration](configuration.md#optional-logical-run-budgets) controls
elapsed run wall time, received host service calls, service artifact snapshot bytes
and next-attempt observed-token admission. Counts survive attempt boundaries and
include final file/voice preparation. The rejected call/snapshot retains its count.
The timer and boundary checks propagate abort through SDK and capability signals;
no partially prepared response is committed on budget abort. A service snapshot
may remain unreferenced after interruption; retention/GC policy is unchanged.

Host service calls are measured after owner/role/scope checks. SDK arbitrary code,
browser calls, provider plugins and other integrations are not universally
intercepted. This is a service budget, not filesystem isolation or a universal
resource quota. The normal service run supplies the abort controller; direct
standalone Agent invocation checks boundaries but cannot abort a caller-owned
signal. Token admission uses attributable input plus output only at the next
attempt. Turn-end usage cannot enforce an in-flight token ceiling, bound dollar
cost, measure subscription windows or prove no quota spend when usage is missing.

Telemetry validation or SQLite failures drop the observation and increment a
bounded content-free in-memory `observations.dropped` counter. Budgets are maintained
in memory independently of receipt writes; telemetry storage failure never changes
a successful user execution into a failure. There is no external collector or
retention deletion introduced.

## Migration, backup and rollback

Tables `run_observations`, `attempt_observations`, `active_attempt_observations`,
`observation_links`, and `usage_baselines`, plus a tenant salt in existing `meta`,
are additive. Preserve operational rows, auth, queue defaults and output routes.
Take the existing online SQLite backup before rollout. Backups include these
private tables and salt; do not publish them. Rollback to the previous application
leaves additive tables ignored; disable the four optional settings first. Do not
drop private observations automatically. Returning to this version invalidates
retained baselines and closes unfinished receipts conservatively. No deployment,
external exporter, live model/account/Telegram validation or container build is
claimed by synthetic local tests.


## Cancellation settlement

Logical observations finalize after response commit or owned execution settlement. Cancellation and timeout/budget remain distinct. The reviewed fixed `execution_unknown` reason records bounded supervision failure without process identifiers, stderr, arguments or outcome text. Model-reported checkpoints/results live only in private job state, not receipt payloads. Recovered cancellation remains requested/unknown and reserves capacity; see [task outcomes](task-outcomes.md).
