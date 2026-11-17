# Changelog

## Unreleased

- Added a fail-closed isolation check for the pinned Codex runtime. It returns a failure when restricted execution cannot protect the disposable fixtures or the sandbox cannot start. See the [Linux isolation check](docs/action-policy.md#target-linux-release-check).
- The disabled restricted profile grants read access to the exact pinned Codex executable on Linux so Bubblewrap can re-execute it inside the sandbox.
- The Linux isolation check uses a shell fixture to verify filesystem and process denials in environments where the sandboxed Node probe cannot start.
- Added a synthetic check that routes a pinned Codex tool turn to a separate Docker executor over stdio, without model credentials or a live bot.
- Added a host launcher for one networkless executor with fixed resource limits and container cleanup on normal exit or cancellation.
- Added a private Unix socket route for trusted harnesses to reach the executor launcher without direct Docker access, with per-connection cleanup after a launcher crash.
- Added a disposable authenticated acceptance check for a model-initiated scoped bridge read and shell call through the offline executor.
- Added an opt-in isolated route for regular research with a remote-only executor and a read-scoped bridge on trusted loopback HTTP.
- Added a separate opt-in to run memory, learning, and research-draft reviews in the offline executor while preserving their schema-only results.
- Added an opt-in ordinary worker route that copies an assigned attachment into the offline executor and delivers named outputs through the immutable artifact outbox.
