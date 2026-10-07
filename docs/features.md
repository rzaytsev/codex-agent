# Feature inventory and acceptance map

This catalog reconciles the original product decisions with current source.
Implemented means code exists; the tests listed cover specific behavior, not a
blanket claim that all user flows work on every deployment. Personal operational
receipts are excluded. Consult [implementation](implementation.md) for limits.

| Feature / decision | Current behavior | Code and verification entry point |
| --- | --- | --- |
| Concurrent shared profiles | Complete profile reads, SHA-256 compare-and-swap exact patches and guarded legacy replacements; custom text and managed learning preserved | [Memory](memory.md#concurrent-profile-updates); `src/profiles.js`; `test/profile.test.js`, `test/integration.test.js` |
| ChatGPT subscription runtime | Pinned Codex SDK/CLI; forced ChatGPT login; no API-key fallback; account/model eligibility still applies | `src/agent.js`, `src/main.js`; `test/integration.test.js`, `test/usage.test.js` |
| Telegram ChatGPT login | /auth sign-in/replacement, status/cancel, first-start prompt, persistent credentials, drain active work and expire stale codes | [Authentication](authentication.md); `src/auth.js`, `src/codex-account.js`; `test/auth.test.js` |
| Multiple independent bots | One token, owner, Compose project, workspace and Codex home per instance; shared image | `bin/agent`, `compose.yaml`; `test/instances.test.js` |
| Agent messaging | Optional authenticated mailbox, saved task requests, owner acceptance, durable replies/status and laptop SSH skill | [Messaging](agent-messaging.md); `test/mailbox.test.js`, `test/agent_mail.py` |
| Private configuration | Ignored env, optional override, optional three-file profile seed; external persistent data | [Deployment](deployment.md), [privacy](privacy.md); instance/seed tests |
| Owner privacy | One numeric owner; private sender equals recipient; groups require direct owner linking and owner mentions; shared owner knowledge/tools with conversation-scoped context; unknown input ignored before persistence/download | [Conversations](conversations.md); `src/config.js`, `src/conversations.js`; `test/conversations.test.js` |
| Conversation routing | Stable IDs across renames/migration; per-conversation FIFO/main session, source-bound jobs/schedules/files, disconnected delivery blocking and shared execution limits | `src/conversations.js`, `src/store.js`; `test/conversations.test.js`; migration/model and real Telegram acceptance remain required |
| Main conversation | Configurable model, low default reasoning; saved Codex thread; /new resets thread while retaining durable data | `src/agent.js`, `src/service.js`; assistant/integration tests |
| Background work | Atomic job/settings/actor/title/acknowledgment admission; optional stable request keys detect conflicts and deduplicate retries; worker/research/review profiles, bounded concurrency/timeouts, task state, concise request-language start acknowledgments, direct completion text/files without another main turn | `src/service.js`; admission/integration/assistant/progress/tooling/latency tests |
| Commands and cancellation | /help, /auth, /tdl_auth, /usage, /status, /new, /cancel, /stop, /location; /start begins login if signed out, otherwise onboarding conversation | `src/telegram.js`, `src/service.js`; progress/usage/location tests |
| Responsiveness | Typing refreshed every four seconds; nonblocking upload indicators; committed replies wake delivery immediately; no automatic working acknowledgment or busy-turn queue notice | `src/telegram.js`, `src/service.js`; progress/latency tests |
| Bounded history injection | Fresh threads receive the latest twelve history entries; resumed threads receive unseen entries from that tail, including directly delivered worker answers | `src/agent.js`; `test/latency.test.js`; model timing depends on account and workload |
| Personality and profile | SOUL.md character; USER.md explicit facts/preferences; skippable onboarding; atomic profile writes; image-owned core and role-specific prompt contracts | [Prompts](prompts.md); `templates/AGENTS.md`, `src/agent.js`, `src/service.js`; prompt/assistant/seed tests; quality needs real conversations |
| Structured memory | Facts/projects/episodes/procedures; SQLite + FTS5, versioned corrections, provenance explanations, recursive source review, scoped forget preview, certainty, optional validity/review dates and exact entity/project filters, generated Markdown | [Memory](memory.md), `src/memory.js`; `test/memory.test.js`, optional `scripts/memory-smoke.js`; [quality evals](memory-quality-evals.md) |
| Continuous learning | Idle sourced proposal/validation loop, versioned scoped trials, managed profile sections, immutable image core, question deduplication and explicit rollback | [Learning](learning.md); `src/learning.js`; `test/learning.test.js`; optional isolated model smoke and [quality evals](memory-quality-evals.md) |
| Quiet consolidation | Daily/weekly bounded read-only proposals, atomic application/checkpoints, idle scheduling and user interruption | memory/service modules; memory tests; quality needs observation |
| Proactive reflection | Daily/weekly/monthly review of history plus available authorized sources; coverage tracking, empty replies, quiet hours | `src/service.js`, [workflow](workflow.md); assistant tests |
| Reminders and scheduled tasks | Atomic durable one-shot/cron admission; immutable scoped keys return original responses or conflicts; explicit cancellation/new key for changes; reminders need no model; tasks use workers | [Workflow](workflow.md#schedule-admission-and-changes); store/service/MCP modules; admission/integration/assistant/backup tests |
| Text and forwarded input | Preserve text, captions, original files and available forward provenance | `src/media.js`, `src/service.js`; assistant tests |
| Images and PDFs | Image model input; PDF text extraction; originals retained on error; OCR tools available for agent use | `src/media.js`, Dockerfile; assistant tests and deployed tooling smoke |
| Voice input/output | CPU faster-whisper input; local eSpeak NG + FFmpeg OGG/Opus output; send_voice queues actual audio | media/Telegram/MCP modules; `test/voice.test.js`; real playback requires acceptance |
| Deliverables | Structured files from main and workers; photos with document fallback; immutable private snapshots before atomic queue commit; hashes, original MIME/filename and scoped routes verified into exact upload bytes; legacy operator gate; indefinite retention | [Artifacts](artifacts.md); service/store/Telegram modules; `test/artifacts.test.js`, `test/tooling.test.js`, progress tests |
| Browser interaction | Headless Chromium + pinned Playwright MCP; isolated main/worker turn sessions, screenshots/downloads under outputs | `src/agent.js`, `scripts/browser-smoke.js`; integration tests and real browser smoke |
| Location | Direct pins/live edits; temporary location for strictly 12 hours, then default; explicit place wins; no invented home coordinates | `src/location.js`; `test/location.test.js` |
| Maps | Optional Google Places/Routes key, separately billed; OpenStreetMap fallback with explicit limitations | `shared-skill/google-maps/`; helper CLI/manual validation |
| Shared workflows | learn, scrape, skillify, investigate, combined planning and project-manager; generated skills stay private | [Skills](shared-skills.md), `scripts/shared-skills-smoke.js`; runtime discovery/evaluation |
| Documents and Python | Writable persistent venv; uv, scientific/document libraries, Pandoc, LibreOffice, OCR and system tools | `src/python.js`, Dockerfile; tooling tests and `scripts/tooling-smoke.py` |
| Daily cleanup | Idle daily maintenance, age thresholds, preserve sensitive/nonreproducible data, private report, yield to intake | `templates/CLEANUP.md`, `src/service.js`; tooling tests; actual deletion choices need runtime review |
| Optional account tools | Per-instance Codex plugins/MCP and Google connectors; no automatic account grants | [Google services](google-services.md), `scripts/google-status.js`; runtime metadata + authorized operation |
| Desired plugin list | Per-instance seed/plugins.json; installs missing plugins after verified login, preserves existing/disabled plugins, reports failures without blocking work | [Configuration](configuration.md#desired-plugins), `src/plugins.js`; plugin/auth/instance tests |
| Telegram user content | Pinned tdl CLI, private per-instance user session, serialized access and a bounded reading skill; owner-verified bot QR login with status/cancel and terminal fallback for 2FA | [Telegram reading](telegram-read.md); wrapper/QR lifecycle tests and runtime acceptance |
| Private run observations and budgets | Versioned content-free private receipts, single terminal outcomes, transactional cumulative thread accounting, conservative unknown gaps and optional wall/service-tool/artifact/next-attempt token admission limits | [Observations](observations.md); `src/observations.js`; `test/observations.test.js`; no exporter or universal code/browser interception |
| Usage reporting | /usage reads subscription windows/reset times via short-lived app-server; typed limit errors; no blind task replay | `src/usage.js`; `test/usage.test.js` |
| Durable recovery | Persist input before processing; recover interrupted work without replay; explicit uncertain sends | `src/store.js`, `src/service.js`; assistant/integration tests |
| Cancellation and queue reliability | Abort media/voice work, revoke turn tools on all exits, atomically queue final responses, avoid quiet-hour and maintenance backlog starvation | [Security and reliability](security-reliability.md); media/lifecycle/reliability tests |
| Host backups | Separate encrypted repositories, hourly timers, month retention, real mount coverage and online SQLite snapshot | [Backups](backups.md); `test/backups.py`, host backup/restore drill |

## Deliberate limits and superseded proposals

- Exactly one owner per container. Earlier multiple-owner allowlists and nested
  memory/users directories were replaced; legacy files are preserved on migration.
- JavaScript with the TypeScript SDK is the selected execution path. A full
  app-server interactive client was an early proposal. App-server is currently
  used for focused authentication/metadata/usage/discovery helpers.
- Messages received during a turn are queued. Live steering and automatic
  main-model reasoning escalation remain unimplemented proposals.
- Browser login/cookies do not persist between turns. No natural neural TTS or
  separately billed OpenAI speech/image API is integrated. Built-in image
  generation is runtime-dependent and has no project end-to-end acceptance claim.
- Telegram topics/threaded UI are BotFather settings, distinct from internal
  Codex thread IDs; the app neither creates topics nor sends message_thread_id.
- Telegram language-specific command menus may override the registered defaults.
  User voice privacy settings can reject otherwise valid audio.
- Downloads are capped at 20 MiB; outgoing artifacts at 49 MiB; photo preview
  threshold is 10 MiB. Albums are handled as separate messages. OCR is agent-led.
- Generated code has the container's granted access; prompt rules alone are not
  a filesystem boundary. Curator/worker service restrictions do not constitute
  strong isolation from arbitrary code running inside that same container.
- No exactly-once sending, comprehensive erase, semantic/vector memory search,
  automatic external-account setup or guaranteed full disaster recovery.

See [security and reliability](security-reliability.md) for attachment storage,
schedule reconciliation, dependency-review scope and remaining trust boundaries.

## Concrete acceptance flows

1. Two synthetic instances resolve to distinct projects, credentials and mounts;
   private overrides/seeds affect only their selected instance.
2. A new owner starts /start, supplies a fact, corrects it, then retrieves the
   correction after restart and /new. The prior value is only historical.
3. Forward a PDF plus a voice instruction, obtain a saved summary and a scheduled
   reminder, recreate the container, and confirm original recall/reminder delivery.
4. Start a worker, keep conversing, request status, cancel it and verify completed
   external effects are not falsely reported as undone. Send an actual artifact.
5. Open a page in Chromium, inspect it and receive its real screenshot. Exercise
   local document conversion and requested voice playback separately.
6. Verify independent daily cleanup, memory consolidation and reflection schedules,
   quiet hours, coverage limits and no repeated empty notifications.
7. Restore a consistent backup into isolated data directories; validate profiles,
   auth presence, history, schedules, memory and files before any authorized start.
