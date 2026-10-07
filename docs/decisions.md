# Design decisions

## One personal agent, several conversation threads (COD-1–COD-5)

- Share owner memory, rules, profiles, learning, files, skills and integrations
  across the DM and linked groups. Only the configured owner can instruct the bot.
- Keep recent context, model threads, queues, task origins, conversation settings,
  cancellation and delivery separate. Explicit history retrieval can cross chats.
- Use one canonical SQLite database with explicit conversation query scopes and
  namespaced session metadata. Consolidate and learn once across owner evidence.
- Preserve old group DBs/files and import records atomically with remapped evidence,
  tombstones, revisions and collision-checked rollout copies. Archive conflicting
  facts and retire conflicting rules; never silently overwrite owner knowledge.
- Retire separate group execution and neutral profiles. This supersedes the initial
  COD-3 multi-participant isolation design; per-owner container boundaries remain.
- Keep addressed intake and fair shared capacity. Account login challenges and
  mailbox acceptance stay in the DM. Replies are visible to the selected audience.
  See [conversations](conversations.md) for migration and validation.

## Desired plugins install after login

An optional per-instance `seed/plugins.json` declares exact marketplace references.
The service reconciles missing plugins after verified login, before new model work,
and after `/auth` completes. Build-time installation cannot use the instance's
ChatGPT account and would be hidden by its persistent Codex-home mount. Existing
and explicitly disabled plugins are preserved; no automatic removal or permission
grants. Bounded failures are reported and allow ordinary assistant work to proceed.

## Telegram user QR login stays outside model execution

The service owns `/tdl_auth`, status and cancel, draining active work before a
private PTY helper runs pinned tdl. Temporary credentials replace the owner
namespace atomically only after successful login and numeric owner verification.
The helper and normal wrapper share an exclusive lock. Durable delivery contains
challenge references, resolved to the current QR just before sending; credentials
and provider output stay outside SQLite/model history. Cancellation, restart and
expiry invalidate challenges. Telegram 2FA passwords remain a terminal workflow.
The helper never accepts a password through its control pipe.

## Implemented choices

- Wake the durable outbox after committed inserts, with the periodic scheduler
  retained for retries and recovery. Typing/upload indicators must not delay the
  real delivery or affect its success state.

- Deliver ordinary worker answers directly through the durable outbox. Workers
  prepare the user-facing answer; another main-model rewrite adds latency and
  can wait behind a busy conversation. Keep current-session results in history
  for follow-up questions and preserve source-bound late-result delivery.
- Inject only unseen service history into resumed model threads, with a
  successful-turn cursor and bounded fresh-thread bootstrap. This limits repeated
  context growth while retaining durable transcripts and retrieval tools.

- Telegram user-content reading uses pinned tdl plus an original shared skill,
  separate from Bot API intake and ChatGPT authentication. Per-instance sessions
  persist in private workspace state; a wrapper serializes calls and keeps
  login/storage settings fixed. Skill restrictions scope ordinary use to reads,
  rather than claiming the full upstream executable has no write capabilities.

- One Telegram owner per instance, with isolated workspace, state and Codex home.
- Node.js 24+, pinned Codex SDK/CLI, service-owned MCP tools and SQLite.
- ChatGPT authentication; no automatic API-key billing fallback.
- Private Telegram chats, numeric owner checks, long polling and durable delivery.
- Local Whisper/eSpeak voice tools; optional providers require explicit setup.
- One main conversation plus bounded worker jobs; configurable model profiles.
- Personal character/profile files and private generated skills.
- A public reusable source tree, ignored private instance configuration, and
  persistent data outside source sync. Configuration is never baked into images.
- Separate Compose projects selected by a launcher; shared public skills read-only.
- Public examples use synthetic names and neutral defaults. Real host paths,
  account connections, operational history and migrations remain private.

## Operator decisions

Each operator selects bot names, owner, timezone, model profiles, source mounts,
account connections, notification cadence, backup locations and off-host policy.
Standing authority for external actions and comprehensive transcript/backup
retention must be chosen deliberately. Optional connectors are not configured
merely by installing the runtime. Deployment and publication require authorization.

## Structured memory (2026-10-02)

- Keep the compact profile and personality separate from facts, project context,
  episodes and procedures. SQLite owns records and revisions; Markdown views
  make them inspectable and compatible with host backups.
- Start with local FTS5 retrieval, explicit evidence and revision-checked
  corrections. Add semantic retrieval only after measured recall misses justify
  another runtime dependency/provider.
- Capture useful memories during work, then consolidate collected evidence
  quietly at 03:15 daily and Sunday 03:45 in the instance timezone. Existing
  cleanup and motivational reflection jobs retain their separate purposes.
- Use read-only model proposals with atomic service-applied batches/checkpoints.
  A summary is not independent confirmation. Do not delete records solely for age.
- See [memory.md](memory.md) for implemented behavior and limits, and
  [memory-research.md](memory-research.md) for the primary research.

## Reliability hardening (2026-10-02)

- Keep supplied filenames as provenance; use generated attachment storage names
  in a separate directory to prevent collisions with service metadata.
- Propagate cancellation across preparation, model and voice work. Revoke turn
  capabilities even when setup fails. Prepare final responses before committing
  delivery entries and history atomically; already performed actions remain real.
- Treat malformed send responses as uncertain delivery to avoid blind duplicates.
  Select eligible deliveries before batching so quiet-hour backlog cannot block
  requested replies; skipped maintenance does not consume worker capacity.
- Validate configured cron expressions at startup and reconcile reflection
  configuration without resurrecting unchanged, explicitly cancelled schedules.
- Use additive indexes for growing durable queues rather than deleting history
  or introducing a separate queue service.
- Preserve the single-container autonomy model and state its limits explicitly.
  See [security and reliability](security-reliability.md) for verification and
  remaining runtime boundaries.

## Telegram authentication (2026-10-02)

- Retain SDK model turns; use native app-server device-code login for the owner
  command and first-start setup. Codex owns OAuth, token storage and refresh.
- Drain active model work before changing credentials; keep the current login
  until native authorization succeeds. Recheck after cancellation or restart.
- Persist only attempt markers/references, never one-time codes in the outbox.
  Reset the model thread after completed or uncertain login attempts while
  preserving owner-bound local data. See [authentication](authentication.md).

## Agent messaging (2026-10-02)

- Optional central SQLite mailbox with authenticated clients and mutual peer
  allowlists; existing instances retain separate owners and private state.
- Laptop access uses a skill and scripts over SSH, with no new MCP server.
  Container agents extend the existing assistant tools.
- Peer intake saves and notifies, without model execution. Task requests await
  direct receiving-owner `/mail accept ID` before creating one worker.
- Stable request IDs support transport retries. Receipts/status are automatic;
  selected results require explicit replies. No automatic reply loops.
- See [agent messaging](agent-messaging.md) for limits and acceptance.

## Superseded alternatives and deferred work

The original app-server-first/Python proposal was replaced by the smaller Node.js
SDK implementation with service-owned MCP. Focused app-server helpers remain for
authentication, usage and metadata. Multiple owners in one container were removed in favor of
strict single-owner isolation and flat memory directories. A default root .env
was replaced by explicit instances, now under private/instances. Mutable public
skills were replaced by read-only public mounts and deliberate private copies.

Persistent browser login, live turn steering, automatic reasoning escalation,
semantic memory search, neural voice and comprehensive erasure remain deferred.
Reflection notifications depend on useful findings and quiet hours; their quality
and all-source coverage require real authorized connections. Owner-authorized autonomy stays within granted resources and the conservative
action policy, including authenticated confirmation for selected external effects.
Retrieved content and development agents receive no blanket operational authority.

## Automatic learning within a stable core (2026-10-03)

- Retain user-chosen goals, privacy and authority in an image-owned core supplied
  after editable instructions on each SDK turn. Ordinary full-access code retains
  existing filesystem/account privileges; the core is not a new execution sandbox.
- Learn through small sourced deltas, independent proposal/validation turns and
  service-owned SQLite revisions. Preserve custom profiles and use marked projections.
- Start operating lessons as scoped trials. Promote only with later evidence, and
  retire harmful changes on explicit feedback. Validation is not proof of benefit.
- Keep useful knowledge-gap questions durable, offer once within a daily limit,
  honor quiet hours/dismissals, and never treat silence as consent.
- Reuse existing history, jobs, scheduling and delivery; add no provider, vector
  service or weight training. See [learning](learning.md) and [research](memory-research.md).

## Prompt contracts match service roles (2026-10-04)

- Keep repository contributor instructions separate from runtime workspace
  guidance, character and owner facts. Image-owned core and role rules reach
  existing workspaces without replacing personal profiles.
- Supply role/output instructions as SDK developer context, before the stable
  core; keep requests and retrieved sources in turn input. Internal reviews omit
  editable workspace persona instructions, disable native project AGENTS.md
  discovery, and use their specific proposal/validation schemas. Global Codex
  instructions remain an operator-managed input.
- Describe existing tools accurately: workers return requested speech through
  final structured output; `send_voice` remains a main tool. Read-only turns do
  not advertise delegation or bypasses. No permissions, queues or routes change.
- Preserve shared-owner memory and conversation-specific delivery. Add sourced
  memory, task handoff and outcome-verification guidance, with synthetic assembly
  checks and explicit model/deployment acceptance limits. See [prompts](prompts.md).

## Silent busy-turn input queue (2026-10-03)

- Remove the automatic busy-turn queue notice in shared intake code for every
  instance, without adding a per-instance flag. Durable queuing, ordering, normal
  replies and owner-controlled `/stop` remain unchanged.
- Keep authentication readiness notices and explicit task/status/error responses.
  Live steering remains deferred. Existing containers need an updated image and
  recreation; synthetic regression tests do not establish Telegram acceptance.

## Natural task-start acknowledgments (2026-10-03)

- Let the main agent supply a short acknowledgment in the current request’s
  language through `create_task`, avoiding language detection heuristics and a
  second model call. Persist it with the job and send it unchanged at worker start.
- Keep the descriptive title and ID for /status. Omit the hardcoded English start
  wrapper; legacy jobs without an acknowledgment start quietly. The tool and
  turn instructions ask the main agent to avoid duplicate final acknowledgments.
- Tests prove exact delivery payloads for Russian, Spanish and English plus
  persistence and validation. Model language choice still requires live acceptance.

## Conflict-checked shared profiles (2026-10-04)

- Use content hashes and small exact patches for shared USER.md/SOUL.md updates.
  Atomic rename alone prevents partial files, but cannot detect stale full rewrites
  from concurrent conversation mains.
- Preserve the full-replacement tool with a supplied hash or single-use same-turn
  read snapshot. Missing/stale snapshots fail closed with current content to
  reconcile, rather than allowing an unguarded compatibility path.
- Keep learning projections service-owned, custom sections intact during patches,
  and existing role/owner/source-routing boundaries. The synchronous service
  critical section covers conversation tools and learning projection, not external
  filesystem writers. No new database, provider or profile history is introduced.
- See [memory](memory.md#concurrent-profile-updates) for the API and limits.

## Explicit memory validity and scoped recall (2026-10-04)

- Add optional observed/valid/review dates and single exact entity/project tags to
  the existing versioned SQLite records. Preserve old records, omitted metadata
  on corrections, provenance, revision conflicts and atomic consolidation.
- Exclude only explicitly outside-validity records from current search/context;
  keep review-due records with an advisory marker and retain historical evidence.
  No inferred TTL, automatic expiry writes, deletion or new maintenance task.
- Apply filters before the existing FTS/list limits without changing ranking.
  `as_of` means valid-time filtering of the latest/selected record, not automatic
  revision selection or transaction-time reconstruction. Explicit revision reads
  remain the historical path. See [memory](memory.md) for boundary details.

## Evidence invalidation and scoped forgetting

- Block forgotten history IDs for every save origin and destination key. Retain
  that owner-bound ledger separately from key tombstones. Restoration is disabled
  at the tool/service/storage boundary, including the legacy restore=true option;
  a future owner-authorized remember-again workflow is deliberately deferred.
- Track exact revision dependencies. Corrections and forgetting invalidate
  descendants recursively; stale derived content stays inspectable and is
  excluded from ordinary recall until re-evidenced. Never infer semantic
  dependence solely from shared history or delete independent facts in a cascade.
- Conservatively flag shared-history memory and learning for review, preserving
  content and revisions while suppressing projections and pending questions.
  This supersedes deleting learning records merely because they share a source ID.
- Provide read-only impact preview and evidence explanation. State retention and
  provenance-validation limits explicitly; source content grants no authority.

## Atomic, conflict-checked admission (2026-10-06)

- Commit task data and a durable owner/conversation/intent request-key ledger in
  one `BEGIN IMMEDIATE` transaction. Retain only a versioned canonical SHA-256
  payload fingerprint, resource ID, admission response and creation time in the
  ledger; task/schedule data remain authoritative. Keep the audit across cleanup.
- Prefer explicit stable task request keys. Matching retries return the original
  result; changed execution or authorization-related intent conflicts. Preserve
  keyless compatibility with atomic writes and documented duplicate-retry risk.
- Treat schedule keys as immutable creation requests, including previously saved
  rows matched on first retry. Deliberate changes cancel the old schedule and
  create with a new key. Runtime firing/cancellation cannot resurrect a request.
- Scope admission to owner and conversation rather than model session, so response
  loss and session rotation cannot silently duplicate admitted work. This is local
  admission idempotency, not exactly-once execution or external delivery. No queue,
  overlap, misfire or configured maintenance policy changes are introduced.

## Explicit scheduler occurrence policies (2026-10-06)

- Add unique schedule/UTC occurrence job links and a retained occurrence ledger;
  commit them with due advancement. Preserve unknown identity on old jobs rather
  than inventing a backfill. Keep omitted legacy queue/one-overdue semantics.
- Use nullable explicit policy/goal intent fields without Zod defaults, preserving
  exact prior Task1 version1 fingerprints and checking legacy adoption. New explicit
  behavior changes conflict under an old request key.
- Bound explicit catch-up per tick and retain skipped ranges without iterating an
  unbounded outage. Coalesce supersedes only queued jobs; active payloads stay intact.
  Treat cancel_requested as active in scheduler/maintenance overlap checks.
- Only requested bounds/goals affect scheduling. Count admitted attempts and
  report exhaustion separately from achievement. Host completion uses exact
  authenticated owner-DM assertion after a settled occurrence, never a silent
  semantic heuristic or arbitrary model claim. Retain provenance and all audit.
- Keep maintenance, reflection, group source routes, no-model reminders and remote
  uncertainty contracts. See [workflow](workflow.md#occurrences-overlap-and-downtime).

## Immutable outbox files

- Prepare ordinary main/worker/voice snapshots and durable metadata before the
  final SQLite response transaction; publish all references atomically. Retain
  orphan inventory indefinitely without automatic GC.
- Verify route, size and SHA-256 into the exact buffered upload bytes. Deterministic
  integrity failure is local failure; remote uncertainty remains distinct.
- Preserve existing path-only rows as gated legacy rather than inventing their
  enqueue-time contents. Keep privileged auth challenges on their existing lifecycle.
- Reject sensitive paths, symlinks and hardlinks at the service boundary. Same-grant
  arbitrary code remains outside this protection. See [artifacts](artifacts.md).

## Private observations remain local and conservative

Keep typed run/attempt receipts in the existing private SQLite database; do not add an exporter, collector or telemetry infrastructure. Codex SDK 0.159.2 completion usage is a cumulative thread total. Derive deltas only with a transactional same-process serialized baseline; retain cumulative measurements and mark gaps unattributed. Omit cache-write counts because the pinned parser synthesizes zero when the provider omits that measurement. Run completion includes artifact preparation, while delivery remains a separate outbox lifecycle. Optional budget settings default to disabled and preserve schedules and queue policy. See [observations](observations.md).

## Typed actions and exact owner consent (2026-10-06)

Use one strict registry for MCP advertisement and direct service validation.
Preserve local orchestration/delivery behavior; external mail is the first exact
prepare/approve/commit broker. Bind payload and authority/version/expiry, commit
consumption with the durable outbox and reconcile unknown remote effects without
replaying sends. Configuration can narrow authority only. Unbrokered code/browser/
third-party actions remain outside the policy. Research uses read-only settings;
its disposable cwd is an opt-in prototype. Actual macOS canaries demonstrated
readable credentials/foreign tasks with denied writes, so full isolation is an
incomplete and blocking requirement. Stage A registry/ledger/prototype source
functionality can be reviewed independently, without declaring full compatible
isolation complete. Approval previews use service-owned literal delivery; version
2 invalidates uncommitted approvals from the earlier markup preview while
retaining audit/outbox data. See [action policy](action-policy.md).


## Production contracts and outcome-gated learning (2026-10-06)

Keep deterministic real-service/store contract checks separate from opt-in model
quality evaluations. Pair the same fixtures/model/effort/repeats across baseline,
memory-only, learning-only and both; scorer-only final-state/forbidden-action
expectations never enter adapter inputs. Errors stay unscored.

Model validation may accept a reversible trial but cannot prove improvement.
Choose and persist the trial check before observing results; promotion requires
an improved host receipt for the unchanged revision/candidate/check hashes and
new after-trial evidence. Inconclusive stays trial; regression blocks that revision.
Authenticated exact owner-DM outcome commands or verified deterministic host checks
create receipts. New owner preference authority requires transport attribution;
raw user-role history, model origin, hidden forwards, bots and groups are insufficient.
Preserve existing active data and retain receipts/revisions after rollback. Host APIs
are not a same-grant arbitrary-code isolation boundary; credential isolation remains
incomplete and blocking.


## Restricted-read research only (2026-10-06)

Use a separate disabled option for research/read/internal review, with fresh threads
and empty per-attempt cwd. Pinned SDK sandboxMode emits a legacy override, and
persisted profile IDs precede the configured default: omit that flag and never
resume selected attempts or change ordinary main thread/cursor. Generate a fresh
application-owned profile name to avoid merging lower same-name config entries.
Grant minimal runtime roots and exact Node/platform dependencies only; application
file input stays with bounded host context and read broker. Exact synthetic input
grants exist only in the disposable actual-CLI positive control. Reject unsafe
links; no operator root list or automatic broad fallback. Fixed reviewed metadata
joins the registry hash, excluding paths/config/env/selection IDs. Local macOS
fixture protection cannot establish Linux/auth/runtime compatibility or mutual
ordinary worker isolation. Full isolation remains **INCOMPLETE AND BLOCKING**.
See [action policy](action-policy.md#disabled-restricted-read-profile-prototype).

Lower configuration layers recursively merge shell set and MCP tables. A selected
restricted attempt therefore verifies effective configuration through bounded
pinned stdio app-server config/read before SDK construction, rather than trusting
empty-table syntax. Reject extra shell keys, foreign servers and inherited assistant
settings; never rewrite owner configuration. Stable metadata describes the checked
contract without hashing raw config/secrets. Disable startup telemetry/integrations
first, discard diagnostics and await owned child cleanup. This runtime startup can
load auth/cloud/model configuration and create state: anonymous fixtures cannot
approve authenticated compatibility. Configuration races, target Linux acceptance
and full ordinary-worker isolation remain blocking; keep the option disabled.


## 2026-10-07: Separate goal claims from execution and supervise owned child exit

Keep the pinned SDK parser and native model/tool loop, replacing only the private subprocess seam with a version/shape-checked application adapter. This intentionally adds maintenance cost on SDK upgrades in exchange for observable child-exit settlement; compatibility fixtures must pass before changing the pin. Discard stderr and preserve sanitized env/config semantics. Persist bounded model-reported goal/checkpoint data without minting host verification or learning/schedule authority. No automatic second model reviewer, retry or checkpoint replay. Missing exit proof remains requested/unknown and reserves capacity. Same-group signals do not prove escaped-descendant containment. See [task outcomes](task-outcomes.md).

## Context, provenance, skills and compatibility contracts

Keep native Codex compaction and bounded unseen-tail injection; add scoped,
model-reported checkpoint projections with unresolved effects and no replay grants.
Host known quote metadata labels whole mixed messages conservatively; never infer
arbitrary pasted source semantics with regex. Keep eight owned skill mounts in one
source inventory; optional laptop SSH skill remains excluded. Keep volatile browser
paths in turn input and stable developer instructions. Goldens hash effective
registry schemas/authority metadata, parser/supervisor and declared runtime pins.
Synthetic tests establish host/assembly compatibility; upgrades still require the
target image and opt-in authenticated/live gates. Correct empty-MCP claims: lower
configuration recursively persists. No isolation prototype is enabled. See
[runtime contracts](runtime-contracts.md).
