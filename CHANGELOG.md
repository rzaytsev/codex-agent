# Changelog

## Unreleased

- Added a fail-closed isolation check for the pinned Codex runtime. It returns a failure when restricted execution cannot protect the disposable fixtures or the sandbox cannot start. See the [Linux isolation check](docs/action-policy.md#target-linux-release-check).
- The disabled restricted profile grants read access to the exact pinned Codex executable on Linux so Bubblewrap can re-execute it inside the sandbox.
