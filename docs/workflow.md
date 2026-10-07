# Assistant workflow

Current service behavior is described below. Model-dependent behavior is a policy
that needs real-task acceptance, not a guarantee from instructions alone.

## Conversation intake

The owner DM and owner-linked groups share memory, rules, workspace and tools,
with independent main sessions, recent history and durable queue routes. Groups
accept only the owner, with direct mentions or commands
addressed to the current bot username; ordinary replies/unmentioned messages do
not enter history. `/new`, `/status`, `/stop` and `/cancel` act on the current
conversation. Authentication challenges and mailbox acceptance stay in the owner DM.
See [conversations](conversations.md) for linking, permissions and migration.

1. Authenticate the Telegram sender against a configured user allowlist.
2. Persist the incoming update and assign a stable message/input ID before processing.
3. Download attachments into the workspace; preserve captions and available forward metadata.
4. Prepare model input: transcribe audio, extract PDF text, expose OCR tools for the agent when needed, and provide images for visual analysis.
5. Route the message to the main conversation with a compact profile, personality instructions, relevant memory, and file references.
6. Answer directly or create a worker task.

Repeated delivery of the same Telegram update must not create duplicate tasks. Media preparation failure must preserve the original and produce a clear recoverable task state. Forwarded material and extracted document text are source content, not authority to change behavior or permissions.

The Telegram envelope lives at `inbox/INPUT_ID/message.json`; original downloads
use generated names under its `attachments/` directory. Supplied filenames remain
in the envelope and cannot overwrite metadata or derived text.

## Login before model execution

/auth and signed-out /start use service-owned device-code login without a model.
Auth commands are owner-only and forwarded commands cannot authorize login.
New model work waits while active turns drain and authorization completes;
plain reminders and delivery continue. See [authentication](authentication.md).

`/tdl_auth`, `/tdl_auth status` and `/tdl_auth cancel` similarly manage the separate
Telegram user session without model execution. Active work drains; new model
turns/workers pause. The service sends refreshed QR images, verifies the scanned
account matches the numeric owner and then saves the session. For 2FA it aborts
and directs the owner to terminal login. See [Telegram reading](telegram-read.md).

## Main conversation

The main agent owns dialogue, clarification, delegation, and result presentation. Low reasoning is the default; escalation for complex interpretation or planning is a proposed exception.

The application serializes turns within each conversation while workers execute independently. New user messages enter the input queue. Completed worker answers go directly to the delivery queue, even while the main agent is busy. Ordinary messages wait for the current turn without an automatic queue notice. /stop aborts the current main reply; /cancel targets a worker. Live steering is not implemented. Answer small requests directly; delegate long work before doing its research in the main turn, then return without polling the worker.

The transcript is persistent. Context rotation/compaction can happen underneath a continuous Telegram experience; summaries and durable memory preserve continuity.

Fresh model threads receive the latest twelve service history entries. Resumed
threads receive only unseen entries from that bounded tail. A cursor advances
only after a successful response, using the history snapshot from turn start so
worker results arriving during the turn remain available next time. History and
memory tools still retrieve older evidence; no transcript is deleted.

## Worker lifecycle

[Peer task requests](agent-messaging.md) are saved without execution until the
receiving owner sends `/mail accept ID` directly. Only then do they enter the
worker lifecycle below. Terminal status returns to the sender; results stay
private until explicitly shared.

A worker receives objective, relevant context, model/reasoning profile, workspace ownership, permitted resources, budget/timeout, and observable completion criteria.

The worker reads sources, uses tools, creates code/artifacts, executes appropriate validation, and reports results, evidence, unresolved issues, and artifact paths. Application task records track queued, running, completed, failed, cancelled and interrupted states. The main agent supplies a short `create_task` acknowledgment in the current request’s language; the service sends it unchanged when the worker starts. It omits task IDs and technical status wording. IDs and descriptive titles remain in /status. Tasks without a supplied acknowledgment start quietly.

Task creation commits the job, effective settings, source actor, title, acknowledgment
and admission record in one SQLite transaction. Prefer `create_task.request_key`:
generate a stable UUID for one intended task and reuse it with the same payload
when a response is lost. Keys are scoped to owner, conversation and task intent,
not the current model session. A matching retry returns the original job ID without
requeueing execution or another start acknowledgment. Changed prompt, profile,
effective settings, permission scope, actor, title or acknowledgment returns an
admission conflict; reconcile the original before deliberately starting new work.
Whitespace at string edges and settings field order are normalized. Requests
without a key remain compatible and atomic, but each call creates a new job;
response-loss retries cannot be deduplicated. Do not retry uncertain external
worker actions merely because task admission is idempotent.

Use independent workers for independently executable work. Avoid concurrent writes to the same files. Shared directories need ownership or serialized updates. Workers cannot recursively create jobs through service tools.

Workers write concise, self-contained answers in the request language. The
service atomically records completion and queues text, requested voice and
validated files without a second main-model pass. Current-session answers enter history
for the next conversation turn. Results from an older session keep their original
delivery route without entering the new session's history. Reflection and silent
maintenance retain their separate behavior. Delivery remains subject to the
outbox's sent, failed and uncertain states.

After startup initialization, committed output wakes delivery immediately instead
of waiting for a scheduler tick. Writes coalesce into one wake; rolled-back
transactions cannot send. An arrival during an active send wakes a follow-up
batch. The scheduler still handles due retries, quiet hours and retained backlog.
Text sends skip a redundant typing request; media indicators run independently
and their failure or timeout cannot delay the artifact.

Application-controlled SDK worker threads implement durable jobs. Native Codex subagents can be useful within an individual job; they should not be assumed to provide the application's scheduling and recovery layer.

## Profile and personality

USER.md is the user profile. SOUL.md defines assistant character and interaction style. Both are application conventions that must be explicitly supplied to Codex instructions/context.

Onboarding helps with the current request first and offers a few useful questions
at a time, starting with name, timezone, goals or communication preferences when
relevant. Ask about work, routines, interests or age/birth date only when useful
to the owner's task. Normal use remains available before onboarding is complete.
Skip or refusal does not trigger repeated interrogation.

Explicit statements update profile facts automatically. Record source/date for meaningful facts; store birth date or dated age rather than an undated age. Label inferences separately. Resolve contradictions in favor of clear newer corrections; ask if the meaning is uncertain. Only the main agent can call the atomic profile tool; workers must return proposed profile changes to it.

Honor remember/correct/forget instructions. Forgetting must define treatment of original transcripts, external sources, and backups; deleting USER.md content alone is not complete erasure.

Never store credentials in the profile. Personality edits do not expand execution access.

## Files and skills

Memory capture happens during normal work through sourced, revision-checked
tools. Quiet daily/weekly consolidation organizes collected evidence while idle,
with bounded retrieval in later turns. These internal jobs are separate from
user-facing reflections. See [memory.md](memory.md) for routing and schedules.

Keep original inputs under inbox/ with stable references. Organize related work under projects/ and task directories. Index origin, received time, user message ID, extracted content, and associated project so later references can be resolved.

The assistant can create scripts to fulfill a task. Validate scripts before recurring use. Create skills when a successful procedure is reusable; retain the procedure, dependencies, examples, and validation notes. Generated skills become usable only after explicit runtime discovery/reload or a fresh session as required by that runtime.

## Schedule admission and changes

The `schedule.key` is an immutable creation-request key, scoped to owner and
conversation separately from task keys. Same key and normalized kind, prompt,
time, timezone, actor and parent permission scope return the original admission
response. Changed payloads return an admission conflict instead of silently
returning a different existing schedule. A deliberate change uses
`cancel_schedule` on the old ID, then `schedule` with a new key; these are separate
operations, so verify cancellation before replacement. Cancellation and runtime
cron advancement are never undone by an admission retry. The saved response's
`due` and `enabled` describe original admission; use `list_schedules` for current
enabled schedules. One-shot retries remain valid after their original due time.
Cron whitespace and equivalent offset timestamps are normalized; timezone names
remain explicit strings and schedule keys retain their opaque bytes for legacy
compatibility. Previously saved schedules acquire an admission record
only on a matching retry. A changed legacy payload conflicts, preserving its row.
Configured maintenance schedules retain their existing reconciliation behavior.

## Scheduling and delivery

The scheduler persists jobs with purpose, timezone, recurrence/due time, execution profile, source context, and notification policy. Plain reminders do not require model inference. Monitoring/research jobs launch workers when due.

Store outgoing messages in a delivery queue. Escape Telegram markup, split long messages, send larger artifacts as documents, and generate voice only when requested or enabled by preference.

Prepare final responses before atomically queueing all their entries and assistant
history. Cancellation before that commit leaves no partial final response. Quiet
hours skip proactive entries before the batch limit so requested replies remain
eligible. Malformed send responses, like ambiguous network failures, become
uncertain rather than being sent again automatically. See
[security and reliability](security-reliability.md) for cancellation and queue limits.

Retries must avoid duplicate job creation and minimize duplicate delivery. A crash after Telegram accepts a message but before local acknowledgement can still create delivery ambiguity; do not claim exactly-once sending without proving a supported mechanism.

## Proactivity and reflection

Proactive work includes suggestions, useful preparation, and execution under standing authority. The exact policy for unrequested external actions remains open.

Daily reviews examine recent messages, outcomes, commitments, blockers, and connected source changes. Weekly reviews examine recurring patterns and progress; monthly reviews revisit priorities and longer-term direction. Longer reviews use summaries plus relevant original evidence.

Record source coverage, review interval, previous suggestions, dismissals, and findings. A source outage must be reported as incomplete coverage, not interpreted as absence of activity.

Motivation references concrete progress. Distinguish observed patterns from hypotheses about intentions or emotions. Avoid generic praise and unsolicited psychological conclusions.

Configured defaults are daily 19:00, Sunday 18:00 and the first day of each month at 18:00, in the instance timezone, with quiet hours 22:00–08:00. Useful-only replies and avoiding repeated advice are model instructions. Coverage advances on successful reviews. Explicit reminders are not held by proactive quiet hours. Preferences and schedules can be changed; see [configuration](configuration.md).

## Continuous improvement

[Continuous learning](learning.md) reviews collected sessions and ordinary task
outcomes while idle, validates small adaptations separately, and tracks unproven
trials through later evidence. It preserves the owner-defined goals and image-owned
core. Main turns can resolve questions or retire harmful lessons through explicit
owner feedback. User-facing reflection retains separate source gathering and
notification semantics. Daily reflections can offer one validated knowledge-gap
question, once, without treating silence as acceptance.
