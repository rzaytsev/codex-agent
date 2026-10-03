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
and all-source coverage require real authorized connections. Full autonomy is
within granted resources and standing user instructions, not blanket authority
for a development agent or content retrieved from tools.

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
