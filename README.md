# Codex personal assistant

A self-hosted Telegram assistant powered by Codex, with persistent memory,
background tasks, voice, files and independent personal bot instances.

This repository is the reusable blueprint. Personal configuration belongs in
ignored `private/`; runtime workspaces and authentication live outside the
checkout. See [deployment](docs/deployment.md) and [privacy](docs/privacy.md).

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
- [Privacy and publication](docs/privacy.md): public/private boundaries and checks.
- [Security and reliability](docs/security-reliability.md): trust boundaries, failure handling and review limits.
- [Feature inventory](docs/features.md): complete behavior and acceptance map.
- [Development](docs/development.md): contributor workflow and validation.
- [Configuration](docs/configuration.md): defaults and instance controls.
- [Implementation](docs/implementation.md): behavior and verification limits.
- [Backups](docs/backups.md): optional encrypted host backups and restore.
- [Google services](docs/google-services.md): optional account connections.
- [Shared skills](docs/shared-skills.md): public and private skill behavior.
- [Memory](docs/memory.md): records, recall, corrections and consolidation.
- [Requirements](docs/requirements.md), [workflow](docs/workflow.md),
  [architecture](docs/architecture.md), [decisions](docs/decisions.md) and
  [references](docs/references.md): design and source documentation.

Third-party skill sources and supplied licenses remain beside their files.
Review redistribution terms before publishing your own copy; this repository
currently declares no project-wide license.
