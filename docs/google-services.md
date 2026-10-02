# Google services in the containers

Connect Gmail, Google Calendar and Google Drive in the ChatGPT desktop app or at
https://chatgpt.com/apps using the same ChatGPT account/workspace as the containers.
Complete Google's consent screen and grant the scopes you want the assistant to
use. Drive's plugin provides workflows across Drive, Docs, Sheets and Slides.
A Google Maps API key grants no Gmail/Calendar/Drive access.

The account connection can be reused by Codex hosts. You normally do not need a
second Google consent flow on the Docker host when that same connection is available.
Plugins must be installed/enabled, and Google/workspace policy and the granted
scopes still apply. Reconnect in ChatGPT if consent was revoked, expired, has
insufficient scopes, or the container uses a different account/workspace.
Do not copy desktop auth files or export Google refresh tokens into env files.

## Install or inspect

CLI syntax below was checked with the pinned runtime. On the Docker host:

```sh
./bin/agent exec demo assistant node_modules/.bin/codex plugin list
```

Install only plugins missing from that instance's installed list:

```sh
./bin/agent exec demo assistant node_modules/.bin/codex plugin add gmail@openai-curated-remote
./bin/agent exec demo assistant node_modules/.bin/codex plugin add google-calendar@openai-curated-remote
./bin/agent exec demo assistant node_modules/.bin/codex plugin add google-drive@openai-curated-remote
```

Repeat for each separately configured instance when needed. Catalog names can differ by
account/workspace; use the marketplace returned by `plugin list`. These commands
use persisted CODEX_HOME, and container recreation preserves local plugin/config
state. Account-managed plugins can already appear installed through the remote
catalog. Do not install duplicates into a guessed marketplace.

Interactive setup is available with:

```sh
./bin/agent exec demo assistant node_modules/.bin/codex
```

Then use `/plugins` and `/apps`. Open any offered connection URL in your desktop
browser and finish Google authorization there. ChatGPT-hosted Google connections
don't require a desktop Google login inside Linux or an exposed callback port.
Third-party MCP servers have their own OAuth/client configuration and are a
separate integration.

Use `/new` in Telegram after changing plugins; files, profile and history survive.
App-side Google consent does not require rebuilding the assistant.

## Verify access

After this image is deployed:

```sh
./bin/agent exec demo assistant node scripts/google-status.js
```

The helper reads installed app metadata, printing only Google names and
enabled/callable booleans. A failed lookup means unknown access, not proof that
another consent flow is required. Reading the entire app directory timed out;
the helper instead reads the smaller installed-app snapshot and name metadata.

For user acceptance, ask for a small read-only operation, such as listing today's
calendar events or locating a known document. Verify the source and coverage.
Supported operations depend on the actual connector tools and scopes; don't
assume arbitrary email sending or document editing from the plugin name.

## Image generation

The pinned Codex runtime enables built-in image generation by default. Official
documentation says it uses `gpt-image-2` against general Codex subscription limits.
Generating an actual image through our SDK/model profiles has not been tested.
Returned image files can use the existing Telegram artifact delivery path after
the model saves/copies them into its workspace and includes them in `files`.
Direct Images API generation requires a separate API key and API billing;
the assistant's sanitized SDK environment does not pass OPENAI_API_KEY.
No billed image API integration was added by this change.

## Sources

- [Official plugin setup](https://learn.chatgpt.com/docs/plugins).
- [Official app-server metadata](https://learn.chatgpt.com/docs/app-server#apps-connectors).
- [Pinned connector source](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/connectors/src/lib.rs): authorization links point to ChatGPT's app directory.
- [Pinned feature definitions](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/features/src/lib.rs): apps and image generation default to enabled.
- [Official image generation](https://learn.chatgpt.com/docs/image-generation): subscription versus API generation.
