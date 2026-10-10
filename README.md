# Codex personal assistant

A self-hosted Telegram assistant powered by Codex, with persistent memory,
background tasks, voice, files and independent personal bot instances.

This repository is the reusable blueprint. Personal configuration belongs in
ignored `private/`; runtime workspaces and authentication live outside the
checkout. See [deployment](docs/deployment.md) and [privacy](docs/privacy.md).

## Features

- **Codex with ChatGPT authentication:** uses your ChatGPT subscription, with
  device login and account management from Telegram. Saved authentication survives
  container recreation; there is no API-key billing fallback.
- **Persistent conversations and personal profiles:** preserves conversation
  history and customizes preferences, personality and operating instructions
  through `USER.md`, `SOUL.md` and `AGENTS.md`, with configurable models and
  reasoning levels.
- **[Private Telegram topics](docs/conversations.md#private-telegram-topics):**
  automatically follows BotFather threaded mode. Each topic keeps its own recent
  context, model session, tasks and reply destination; owner memory, learning,
  profiles and documents remain shared within the bot.
- **[Topic-specific group conversations](docs/conversations.md):** the owner can
  link groups to the same bot. Direct mentions enter independent conversations,
  with separate recent context, threads and delivery. Memory, rules, files, skills
  and integrations are shared; only the bot owner can instruct it in any chat.
- **[Durable memory](docs/memory.md):** SQLite-backed facts, projects, episodes and
  procedures, with full-text recall, source provenance, confidence, versioned
  corrections, scoped forgetting and readable Markdown projections.
- **[Self-improving behavior](docs/learning.md):** reflects on past sessions and
  tasks, validates proposed lessons, and automatically trials reversible updates
  to profiles and a learned playbook within a stable core. Keeps change history,
  supports rollback and asks focused questions when user input is needed. New trial
  promotion requires a matching host outcome receipt; model completion alone is insufficient.
- **Proactive reflection:** daily, weekly and monthly reviews help identify useful
  next steps toward your goals, while respecting quiet hours. Memory consolidation
  runs separately during idle time.
- **[Scheduled tasks and reminders](docs/workflow.md):** durable one-time
  reminders and recurring cron tasks in your timezone. Simple reminders do not
  require a model call.
- **Background tasks:** delegates research and other work to bounded workers,
  with progress/status commands, cancellation and saved completion files.
- **[Plugins and MCP integrations](docs/configuration.md):** per-instance plugin
  configuration and installation after login, plus optional connected services
  such as Google. Availability depends on the account and separate provider grants.
- **Multimodal Telegram input:** accepts text, forwarded messages, images, PDFs,
  documents and voice messages, with transcription, text extraction and OCR tools.
- **Files and voice replies:** returns generated documents, photos and other
  deliverables through Telegram, with optional synthetic speech replies.
- **Browser automation:** isolated Chromium/Playwright sessions for browsing,
  screenshots and downloads. Browser cookies and logins do not persist between
  turns.
- **[Telegram account reading](docs/telegram-read.md):** optionally reads the
  owner's accessible Telegram content through a separate persisted user-account
  login, with QR authentication controls in the bot.
- **[Reusable skills](docs/shared-skills.md):** includes learning, scraping,
  investigation, planning and project-management workflows, and can create private
  skills for repeated tasks.
- **Coding, data and document tools:** a persistent Python environment with `uv`,
  scientific and document libraries, Pandoc, LibreOffice and OCR tooling for
  analysis and artifact creation.
- **Location-aware assistance:** accepts location pins and live updates, with a
  saved default and temporary overrides; optional Google Places/Routes and an
  OpenStreetMap fallback support location workflows.
- **[Agent messaging](docs/agent-messaging.md):** optional authenticated mailboxes
  let independent assistants exchange messages and task requests, with owner
  acceptance for received tasks.
- **[Private independent instances](docs/deployment.md):** one Telegram owner per
  Docker container, with separate workspaces, authentication and state. Durable
  queues, restart recovery, cancellation and subscription-usage reporting support
  daily operation.
- **[Backups and maintenance](docs/backups.md):** optional encrypted host backups
  and documented restore procedures, plus idle workspace cleanup that preserves
  durable files.

See the [feature inventory](docs/features.md) for detailed behavior and validation
limits.

## Quick start

Requires Docker Engine with Compose on a Linux host, and Node.js 24+ to create
instances or develop the application. All example names and paths are fictitious.

```sh
./bin/agent create demo --data-root /srv/agent-data
```

Edit `private/instances/demo/agent.env`: set a unique Telegram bot token, exactly
one numeric owner ID, and your timezone. On the target Docker host, create the
data directories with access restricted to their owner:

```sh
install -d -m 700 /srv/agent-data/demo/workspace /srv/agent-data/demo/codex
./bin/agent config demo
./bin/agent up demo
```

Send `/start` in the private Telegram chat and complete the offered device login
in your browser. Use `/auth` later to change ChatGPT accounts, `/auth status` to
check login, or `/auth cancel` to cancel. Saved login survives recreation. There
is no API-key billing fallback. See [authentication](docs/authentication.md).
Repeat with another name and bot token for another independent assistant.

If configuration is prepared on another computer, securely transfer its selected
private instance and any private skill overrides to the host. Git does not carry
them. Never start two pollers using the same bot token.

## Development

```sh
npm ci
npm run check
npm test
python3 -m unittest discover -s test -p '*.py'
```

MCP integration tests need localhost socket access. Docker configuration tests
need Compose but no running daemon. Tests use synthetic data and no real bot.

## Documentation

- [Deployment](docs/deployment.md): creation, private seeds, mounts and upgrades.
- [Agent messaging](docs/agent-messaging.md): private bot mailboxes and laptop SSH skill.
- [Privacy and publication](docs/privacy.md): public/private boundaries and checks.
- [Security and reliability](docs/security-reliability.md): trust boundaries, failure handling and review limits.
- [Feature inventory](docs/features.md): complete behavior and acceptance map.
- [Development](docs/development.md): contributor workflow and validation.
- [Runtime contracts](docs/runtime-contracts.md): synthetic context/provenance/skills/pinned-runtime gates; live and full-isolation acceptance remains separate.
- [Configuration](docs/configuration.md): defaults and instance controls.
- [Implementation](docs/implementation.md): behavior and verification limits.
- [Conversations](docs/conversations.md): linked groups, permissions, sessions and routing.
- [Backups](docs/backups.md): optional encrypted host backups and restore.
- [Google services](docs/google-services.md): optional account connections.
- [Shared skills](docs/shared-skills.md): public and private skill behavior.
- [Telegram user content](docs/telegram-read.md): tdl installation, separate owner login and reading skill.
- [Learning](docs/learning.md): automatic adaptation, stable core, questions and rollback.
- [Memory](docs/memory.md): records, recall, corrections and consolidation.
- [Requirements](docs/requirements.md), [workflow](docs/workflow.md),
  [architecture](docs/architecture.md), [decisions](docs/decisions.md) and
  [references](docs/references.md): design and source documentation.

Third-party skill sources and supplied licenses remain beside their files.
Review redistribution terms before publishing your own copy; this repository
currently declares no project-wide license.
