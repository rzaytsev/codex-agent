# Implementation status

This document describes reusable source behavior. Personal deployment receipts
and operational history are private and are not public runtime evidence.

## Implemented

- Immutable ordinary outbox snapshots for main/worker/voice outputs, durable hash
  and route inventory, atomic publication, exact buffered integrity checks before
  upload and explicit legacy gating. Retention is indefinite without automatic GC.
  Synthetic source-change/restart/tamper/symlink/hardlink/route/commit regressions
  pass; deployed Telegram and restore acceptance remain gates. See [artifacts](artifacts.md).

- Application-owned main/worker/read-only/review instructions are SDK developer
  context, separate from source data and requests. Worker voice uses the existing
  service synthesis path; internal reviews omit editable persona instructions and
  keep schema-only output. Core guidance covers shared memory, source routes,
  authority and truthful verification. [Prompt contracts](prompts.md) documents
  initialization/update behavior and synthetic validation limits.

- Optional temporal metadata and exact entity/project tags on structured memory.
  Current search/context filter explicit validity before limits; review dates are
  advisory, historical revisions remain readable, and old records stay unbounded.
  `as_of` filters validity, not historical knowledge snapshots. Synthetic storage,
  migration, MCP and context tests cover these contracts; model tagging/date
  extraction quality needs live evaluation. See [memory](memory.md).

- Owner-linked topic-specific groups with owner-only entity-addressed intake;
  shared memory, rules, profiles, learning, files and configured tools; separate
  main sessions, recent context, queues/settings and source delivery. Canonical
  DB migration preserves legacy evidence, revisions, forgetting, files and rollouts.
  Global resource limits and fair scheduling remain. See [conversations](conversations.md).

- Continuous learning with separate idle proposal/validation turns, sourced
  versioned trials, managed profile projections, image-owned core, bounded questions
  and explicit rollback. Synthetic tests verify storage/lifecycle contracts; actual
  helpfulness needs ongoing outcome evidence. See [learning](learning.md).

- Pinned tdl image installer, per-instance private Telegram user-session wrapper,
  owner-only `/tdl_auth` QR login/status/cancel with staged owner verification,
  interactive `bin/agent tdl-login NAME` fallback for 2FA and read-only mounted `telegram-read`
  skill. Real reading requires owner login and acceptance on the deployed image.
  See [Telegram reading](telegram-read.md).

- Operator-managed desired plugin list, reconciled after verified startup login
  and `/auth` completion, with bounded CLI installs into persisted CODEX_HOME and
  controlled failure reporting. Synthetic plugin/auth tests cover installation,
  preservation, failure and model-readiness gating. Provider access still needs
  account authorization and live acceptance. See [configuration](configuration.md#desired-plugins).

- Optional authenticated agent mailbox, saved task requests with direct owner
  acceptance, attributed replies/status, and a laptop skill over SSH. Source
  tests cover isolation and recovery; live acceptance is instance-specific.
  See [agent messaging](agent-messaging.md).

- Telegram /auth sign-in, replacement, status/cancel and signed-out /start; managed device-code login with persisted credentials and active-work draining. See [authentication](authentication.md) for recovery and live acceptance limits.

- Node.js 24+ application using pinned Codex TypeScript SDK/CLI 0.159.2. This resolves the original app-server proposal in favor of a smaller SDK integration; application-owned MCP tools provide scheduling and orchestration.
- Owner DM allowlist and explicitly linked/addressed groups checked before persistence/download; tools and delivery enforce the source conversation.
- Messages arriving during a main turn queue silently in durable input order for
  all instances. Repeated-intake tests cover eventual replies and deduplication;
  deployed Telegram acceptance requires updating each instance image.
- SQLite persistence for inputs, conversation history, thread IDs, jobs, schedules, reflection coverage, and delivery state.
- Worker start acknowledgments are supplied by the main agent in the request’s
  language and sent without an ID/status wrapper; /status retains task IDs/titles.
  Synthetic tests cover persistence and exact output, not model language quality.
- Main conversation low reasoning by default; asynchronous worker/research/review profiles with configurable models/reasoning and bounded concurrency/timeouts.
- Ordinary worker answers, requested voice and files enter delivery directly,
  without a main-model rewrite. Resumed threads receive unseen recent history
  tail. Regression tests cover busy-main delivery, cancellation, duplicate
  prevention, concurrent results and failure-safe history cursors; measured
  latency remains deployment- and request-dependent.
- Immediate outbox wake after committed writes, including arrivals during another
  send. Text skips redundant typing; upload indicators cannot block delivery.
  Tests preserve transaction rollback, quiet hours, backoff, uncertain sends and
  disconnected routes. The periodic scheduler remains the retry/recovery fallback.
- Authenticated local MCP bridge for history, background jobs, cancellation, profile/personality writes, and reminders/task schedules.
- USER.md onboarding and SOUL.md behavior configuration through hash-checked profile reads, exact patches and guarded full replacements. Concurrent conversation mains receive stale-write conflicts and managed learning sections stay service-owned. Model adherence needs live acceptance and is not asserted from unit tests.
- Original attachment and forward provenance storage, PDF text extraction, image model input, CPU Whisper transcription and local voice generation.
- Formatted Telegram text, chunking, files and requested voice; durable delivery queue with rate-limit retry and explicit uncertain delivery state.
- Daily/weekly/monthly reflection jobs after first authorized interaction; connected sources discovered through configured Codex tools. No external sources preconnected.
- Docker Compose deployment with independent env configs and host mounts per agent, protected persistent authentication, no host ports or Docker socket, and host-backup documentation.
- Default templates plus a non-overwriting additional-instance generator.
- Collision-resistant attachment storage, cancellation-aware media/voice work,
  turn capability cleanup, transactional final responses, fair queue selection
  and validated/reconciled reflection schedules. See [security and reliability](security-reliability.md)
  for exact contracts, tests and remaining boundaries.

## Limits and remaining acceptance

No Telegram token or allowed IDs are populated by development. Agent configs live in private/instances/NAME/agent.env; there is no root/default instance. Each instance needs a ChatGPT device login, available through Telegram /start or /auth. End-to-end Telegram, real model delegation, file recall, onboarding, reflection quality, and real voice transcription require live credentials/input.

Voice generation is local eSpeak (robotic). Whisper needs first-use model download. Scanned-document OCR is available as an agent-operated tool rather than unconditional automatic OCR. Albums are processed per incoming message. PDF errors preserve originals but do not silently claim successful extraction.

Reviews cover history and accessible connectors; daily/weekly/monthly schedule defaults can be changed. Successful review completion advances coverage; failure retains the previous boundary. Quiet hours defer proactive notification delivery, not explicitly requested reminders. Reflection history queries are bounded and require targeted lookup for larger periods.

No exactly-once delivery claim: crashes/network ambiguity can leave uncertain messages requiring review. Interrupted execution is not retried blindly. No arbitrary automatic resume/replay of remote mutations. Cancellation cannot undo an external action already completed.

Owner DM and linked group turns execute with the same granted container access.
Only the configured owner can instruct them; groups never become new owners.
Personal accounts and authentication management remain in the DM. Container
isolation is not a guarantee against every malicious generated program.

Structured forgetting deletes only the selected memory and its versions. Revision dependencies and shared-history memory/learning records retain content and report needs_review, leaving ordinary recall/projections; pending affected questions are cancelled. Read-only preview and provenance explanation expose recorded impact and limits. History, sessions, source files, learning audit rows and backups remain. Restoration is disabled, including the former restore=true API; forgotten keys remain tombstoned until a separately designed owner-authorized workflow exists. No automatic comprehensive erasure or semantic dependence detection is implemented.

Templates initialize missing files only. Generated skills follow Codex's native .agents/skills layout. Dependencies added by generated code should be installed into writable workspace directories because the image root is read-only.

## Public blueprint and private instances

- bin/agent selects a private instance explicitly for every operation.
- Per-instance env files, overrides and profile seeds live under ignored private/.
- Runtime data remains outside the source checkout; missing mount roots fail.
- Generic skills are read-only; editable private copies require explicit mounts.
- Backup helpers read explicit private host settings and instance lists.
- Public Git candidates can be checked with scripts/check-publication.py.

## Verification boundaries

Run npm run check, npm test and the Python backup suite for local validation.
Compose tests resolve two synthetic instances without a Docker daemon. Local
setup/seed tests make no model calls and send no Telegram messages. No tests
assume access to real credentials or private instance directories.

Image builds, host permissions, deployed health, actual Telegram interaction,
account connections and a full backup/restore drill must be checked on the chosen
runtime. Passing local tests does not establish those deployment gates.

## Atomic task and schedule admission

Implemented: additive SQLite `admissions` ledger and synchronous transaction for
`create_task` job/settings/actor/title/acknowledgment plus fingerprint/response.
Optional `request_key` is discoverable through MCP and main role instructions.
Legacy keyless callers create a distinct job per call, with atomic metadata but
weaker retry guarantees. Schedule keys identify immutable creation requests;
changed payloads conflict and matching legacy rows are adopted without mutation.
Fingerprints cover normalized execution intent and authorization-related fields;
default changes that alter effective settings conflict. Owner/conversation/intent
form separate key namespaces. New sessions do not forget admitted requests.

Synthetic `test/admission.test.js` covers intermediate-write, abrupt process exit and ledger rollback,
lost responses, separate-process reopening, matching/default normalization,
changed settings/scope/actor/title/acknowledgment, owner/conversation separation,
cron advancement, cancellation, past-due retry and legacy startup/adoption.
`test/integration.test.js` verifies actual MCP schema/retry/conflict responses and
SQLite snapshot retention. No actual model, Telegram, deployed-image or host
restore acceptance is claimed. Delivery still has uncertain-send semantics.
See [workflow](workflow.md#schedule-admission-and-changes) and
[backups](backups.md#task-and-schedule-admission-migration).

## Private run observations

The service records logical runs through final response preparation, with one terminal outcome distinct from SDK attempt completion. Internal memory/learning batches share their job run and cumulative budgets. Schema 1 stores fresh reviewed fields, effective effort/scope/timeout and a model digest, application release, numeric actual Node version, pinned SDK/CLI versions and developer-instruction/tool-bundle SHA-256 hashes. Failed observations increment only a bounded content-free process counter. The pinned SDK parser is tested through synthetic JSONL subprocesses, including its cache-write zero default and malformed lines. See [observations](observations.md) for attribution, migration and runtime limits. No real model/account/Telegram acceptance is claimed.
