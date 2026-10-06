# References

Consulted during the discussion on 2026-09-30. Recheck before implementation because SDKs and runtime interfaces change.

- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk): TypeScript CLI wrapper and Python app-server integration.
- [Authentication](https://learn.chatgpt.com/docs/auth): ChatGPT subscription sign-in versus API-key billing and CLI login status.
- [App-server](https://learn.chatgpt.com/docs/app-server): threads, model/effort configuration, streamed events, MCP operations, experimental dynamic tools, and plugin management maturity.
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): configurable roles and model/reasoning behavior.
- [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): runtime tool integration.
- [Plugins](https://learn.chatgpt.com/docs/plugins): skills/tools, installation, authentication, and host-dependent availability.
- [Official Codex source](https://github.com/openai/codex): source documentation consulted through Context7 for SDK internals and per-agent model/reasoning overrides.

The initial design preceded the implementation. See the [feature inventory](features.md)
and [validation guide](development.md) for current behavior and verification boundaries.

Implementation references:

- [Telegram Bot API](https://core.telegram.org/bots/api): getUpdates, media, sender identity and output formatting; fetched via Context7.
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk): interfaces verified against pinned installed v1 package and a real client/server test.
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper): installed 1.2.1, verified by synthetic-audio transcription in the Linux container.

The earlier optional OpenAI speech API research was not adopted: this implementation uses local speech without API-key billing.


Restricted-profile prototype source verified against rust-v0.159.2 and installed
SDK/CLI 0.159.2 (2026-10-06), with synthetic actual-SDK argv and actual-CLI sandbox
fixtures; no authenticated model execution:

- [Permission profile TOML](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/config/src/permissions_toml.rs).
- [Profile compilation](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/config/permissions.rs).
- [Legacy syntax and persisted selection precedence](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/config/mod.rs).
- [Native sandboxed filesystem](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/exec-server/src/sandboxed_file_system.rs) (runtime compatibility unverified).
- [Seatbelt construction](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/sandboxing/src/seatbelt.rs) and [minimal platform defaults](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/sandboxing/src/seatbelt_read_only_platform_defaults.sbpl).
- [SDK subprocess argv](https://github.com/openai/codex/blob/rust-v0.159.2/sdk/typescript/src/exec.ts).
