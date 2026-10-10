# Implementation status

This document describes reusable source behavior. Personal deployment receipts
and operational history are private and are not public runtime evidence.

## Implemented

- Private Telegram topics follow BotFather threaded mode automatically. Chat/topic
  pairs keep independent model sessions, recent context, commands and durable
  worker/reminder/artifact destinations, including restart and late results.
  Owner memory, learning metadata, profiles and documents remain shared, with one
  maintenance loop across conversations. Toggle-off retains topic queues without
  merging or redirecting them. Synthetic routing, transport fallback and persistence
  tests cover these contracts; actual owner/model thread interactions remain a
  separate acceptance gate. See [private topics](conversations.md#private-telegram-topics).

- Durable scheduler occurrences and atomic advancement, explicit overlap/misfire
  policies and requested goal/bound state with authenticated owner completion.
  Nullable intent columns preserve legacy policies and exact Task1 admission
  fingerprints. Synthetic tests cover slow workers/latest pending promotion,
  cancellation-requested activity, bounded downtime, abrupt process exit/reopen,
  snapshot audit retention, sparse weekly/monthly DST selection, repeated-hour
  advancement inside/outside grace, and owner/source/session integrity. Coalesce
  bounds queued backlog; it does not serialize active workers. Bounds are
  not goal achievement; owner confirmation is an attributed assertion, not
  independently verified semantics. No live model/Telegram/image acceptance.
  See [scheduler contracts](workflow.md#occurrences-overlap-and-downtime).

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

## Typed action policy: Stage A source and incomplete isolation

Implemented one strict MCP/direct registry, conservative configurable categories,
exact literal direct-owner DM mail preparation/approval/commit, transactional one-shot
outbox linkage, restart/crash replay handling and status-only uncertain recovery.
Research/read-only scopes disable integration mutation surfaces and use pinned SDK
read-only options. Disposable task cwd is optional and excludes copied DB/auth.
Synthetic tests pass these source contracts. The actual local macOS sandbox
blocked writes but allowed disposable credential and foreign-task reads; full
compatible credential/foreign-task isolation is incomplete and blocking. Only
Stage A registry/ledger/prototype source functionality is implemented; the
prototype does not complete isolation acceptance. Live-auth compatibility remains
unverified and requires separate explicit opt-in. No model,
Telegram or deployed image acceptance is claimed. See [action policy](action-policy.md).


## Production memory contracts and learning outcomes

Source implements separate deterministic real-service contracts (`npm run eval:contracts`), four independent quality-ablation modes (baseline, memory-only,
learning-only, both; on/off aliases), and host revision/hash/preselected-check
outcome receipts for new trial promotion. New preferences/styles require bounded
host direct-owner evidence; legacy active data is preserved. Receipt regressions
block promotion and rollback retains audit. Local synthetic checks establish
service contracts only. No live subscription/Telegram or deployed acceptance was
performed; full credential/foreign-task isolation remains incomplete and blocking.
See [learning](learning.md) and [evaluation limits](memory-quality-evals.md).


## Restricted-read profile research prototype

Disabled by default: RESTRICTED_READ_PROFILE_PROTOTYPE uses a fresh empty cwd and
SDK thread for each research/read/internal review attempt, exact runtime/minimal
roots, no application-input/task-directory grants, network-disabled raw shell and
inherit-none shell environment. Conflicting legacy SDK sandboxMode is omitted;
ordinary main thread/cursor and settings remain unchanged. No fallback or state
migration. Actual SDK synthetic argv/parser, cleanup/cancellation, unsafe-input and
fixed registry/permission-hash tests cover source behavior.
The bounded pinned effective-config guard now rejects lower-layer extra shell set,
foreign MCP and inherited assistant settings before SDK construction, with exact
reviewed normalization and fixed errors. Anonymous actual-CLI merge fixtures and
owned helper markers verify these paths; malformed/oversized/runtime/timeout/exit
responses fail closed and owned children are awaited. Startup loads auth/cloud/
model/state machinery, so authenticated compatibility is still unverified.
Local actual CLI macOS canary protected its exact owned fixture routes while builtin allowed reads and
nested execution was unavailable. Full isolation is **INCOMPLETE AND BLOCKING**:
Linux target image, native filesystem/process/proc/IPC/tools/skills and authenticated
parent+MCP compatibility remain unverified. No account/model/Telegram tests or
production enablement occurred. See [precise profile and rollback](action-policy.md#disabled-restricted-read-profile-prototype).


## Task outcome and cancellation boundary

Optional bounded final outcomes/checkpoints are durable and explicitly model-reported; execution completion is separate. Running cancellation is requested before abort and waits for actual owned SDK/media child exit. Unknown cleanup/restart retains requested capacity with no replay. Synthetic pinned parser/argv tests pass; authenticated runtime, escaped descendants and full native isolation remain blocking. See [task outcomes](task-outcomes.md).

## Context, provenance and compatibility contracts

Source adds host known-quote metadata, bounded scoped terminal-result checkpoint
context and stable browser instructions with volatile directories in turn input.
One inventory covers nine owned skill mounts. Synthetic routing expectation checks
and runtime goldens include actual registry schemas/authority metadata, pinned
parser/supervisor and declared versions. No compactor, skill automation or
dependency upgrade is added. Live compaction/semantic quality/cache gains/
authenticated discovery and target image acceptance remain unrun; full isolation
remains incomplete and blocking. See [runtime contracts](runtime-contracts.md).

The final authority correction adds quote-aware history provenance version 1;
retained attribution defaults to unknown for new owner adaptations. Learning and
memory honor the same quote interpretation, and new promotion revalidates saved
explicit-owner receipt sources. Existing active records, versions, receipts and
audit remain intact. Incoming mail accept/reject uses the shared direct-owner gate.
Exact scoped `task_status({id})` exposes full older checkpoints beyond the default
30-job list. Synthetic cross-version and transport regressions cover these paths;
no live integration or full isolation acceptance follows.

## Regular and deep research (2026-10-10)

Implemented `deep_research` admission, task scope, public-source collection, durable
search/source/claim/report records, scoped FTS recall, exact passage checks and
service-owned separate review plus PDF/Markdown/CSV/evidence export. Regular
research remains read-only. New guidance reaches existing custom AGENTS.md through
an append-once section and image instructions; the ninth skill is mounted read-only.
Synthetic tests cover boundaries, corrections, cancellation/restart, snapshots and
immutable source-route delivery. Real runtime/report/delivery rollout evidence
belongs in private receipts; owner quality acceptance is distinct. See [research](research.md).
