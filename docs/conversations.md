# Telegram conversations (COD-1–COD-5)

Implementation milestones:

1. Add stable conversation and main-session identity; preserve existing DM data
   and its Codex thread through an additive migration.
2. Link groups explicitly, accept addressed messages, and retain author identity.
3. Isolate group state and execution; bind service capabilities to the audience.
4. Route durable jobs, schedules, events and delivery to their source conversation.
5. Bound and fairly schedule main turns and workers across the owner; validate
   migration, routing, authorization and cancellation using synthetic fixtures.

All five source milestones are implemented. Local synthetic tests cover the
listed storage/routing/authorization flows, MCP dispatch, restart and shared
limits. The macOS command sandbox probe and Linux separate-executor probe pass.
An isolated authenticated model turn verified native commands, group output and
scoped MCP. Actual Telegram group acceptance remains outstanding.

Target: the reusable local service, followed by a separately authorized image
build and Telegram acceptance. Example: two people mention the bot in group A;
a worker completes after activity in group B and the DM, and only A receives its
result. Neither tools nor generated code may read the DM or B's private state.

One configured owner controls this bot. Group participants are actors, not new
owners. A conversation has a stable UUID, Telegram chat ID, optional reserved
thread ID, lifecycle state, settings, and replaceable main session. Chat titles
are labels, never identity. Group migration updates the transport address only.

The DM keeps its original database, profiles, files, memory and thread. Groups
use separate databases under `state/conversations/ID/` and workspaces under
`conversations/ID/`. Each database records the same stable conversation ID in
inputs, history, jobs, schedules and outbox. Memory, learning, evidence, revisions,
tombstones, projections and checkpoints stay in that conversation's database.
This reuses the existing owner-bound memory implementation without broadening
its scope or mixing group records into personal maintenance.

Group execution must enforce filesystem access, not merely instructions. The
group Codex invocation ignores personal runtime config/rules, disables apps,
plugins, hooks, browser and subagents, and uses a named filesystem profile that
denies the filesystem outside minimal runtime paths and its group workspace.
Profiles, inbox, memory and state are read-only to generated code; only group
outputs, projects and task directories are writable. Read-only tasks and internal
reviews remove those write grants as well.
Command network access and approval escalation are disabled. Account credentials
are used by the Codex client, never supplied as model context. Service tools
validate owner, conversation, session, task, actor and role. No personal USER.md,
location, private skills or connected account context is injected into groups.

Runtime enforcement and native tool behavior require a target-platform probe
before group model execution is enabled. Unsupported enforcement fails closed.
Synthetic tests and configuration inspection do not prove deployed isolation.

The synthetic command probe passed locally on macOS. The pinned CLI's native
image handler passes sandbox context to filesystem reads; this was verified in
[the 0.159.2 source](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/tools/handlers/view_image.rs).
The permission profile follows [official Codex documentation](https://learn.chatgpt.com/docs/permissions).
The Linux separate-executor boundary and an isolated real model/native-tool turn
were verified. Actual Telegram behavior remains a deployment acceptance gate.

The initial 2026-10-03 target-host probe found that the existing Docker security profile
blocks bubblewrap namespace creation. An isolated non-root diagnostic passed
with outer seccomp and AppArmor disabled; that diagnostic configuration has not
been adopted for production. Group execution remains blocked under the current
deployment. The Linux runtime vendor tree needs an explicit read grant so the
sandbox can re-execute its pinned helper. Empty mount-parent scaffolding is
expected; the probe checks private directories and files directly.

For hardened Linux containers, the operator selected separate group executors.
`GROUP_EXECUTOR_SOCKET` selects a host-owned broker through a Unix socket in the
existing workspace mount. Each turn gets a disposable container with only that
group mounted: its workspace is read-only, while outputs/projects/tasks are
writable for ordinary turns. Read-only tasks have no persistent write mounts.
The container has no network, authentication, host Docker access or personal
source mounts, and retains read-only rootfs, dropped capabilities and Docker's
security profiles. The broker validates canonical UUID paths and enforces a
bounded execution pool; it is trusted host infrastructure, never a model tool.

The authenticated Codex client remains in the personal service. Its execution
environment contains only the remote executor, with no local fallback. Native
filesystem operations and shell commands run there. Named local sandbox
profiles are replaced by the container boundary for this mode. The scoped
assistant MCP uses authenticated HTTP in the personal service, preserving role,
actor and conversation checks without putting its capability in executor env.
Disconnect/cancellation closes the transport and removes its container.
Executor reconnects do not preserve a command process; failed operations must
not be blindly replayed.

Models that require Code Mode retain its pinned V8 host. Its JavaScript runtime
rejects imports and has no direct filesystem/network API; it dispatches only
the configured tool catalog. Native operations still use the remote executor,
and service tools still enforce conversation capabilities. Disabling that host
would silently remove tools for models whose metadata requires Code Mode.

Owner-only operations: group linking/disconnection/settings/sharing, `/new`,
authentication, locations, account management, and forgetting group memories.
Members: addressed conversation, group history/memory, scoped task creation,
task status and reminders. Members may cancel their own tasks/turns. Workers
inherit the conversation's permissions and cannot create more workers, change
settings, share private data, or change profiles. External account actions are
unavailable to groups in this version, including owner messages to a group.

Direct bot mentions and `/command@botname` address the bot. Replies without a
mention do not trigger work. Unaddressed messages are not saved or downloaded.
Forum thread messages are rejected in this version; the schema reserves their
transport identity for a future implementation. For plain `@botname` messages,
disable privacy mode through BotFather and re-add the bot to the group, or grant
the bot admin access. With privacy mode enabled, use `/command@botname`; plain
mentions are not among the updates Telegram promises to deliver. See
[Telegram privacy mode](https://core.telegram.org/bots/features#privacy-mode).
Receiving all updates does not broaden application ingestion: unaddressed
messages are discarded before saving or downloading. Bot API entities use
UTF-16 offsets. Refresh bot identity from
`getMe` so username changes do not leave an old mention allowlist.

Settings resolve instance defaults, then conversation settings, then task
overrides. Effective model, reasoning, timeout and tool scope are saved with the
task. Overrides can narrow tool permissions, never widen them. `/new` rotates
only the current main session; late worker results remain deliverable to their
original audience but do not enter the new main session.

Disconnecting blocks input, execution and delivery. No private result is
redirected to a different chat. Reconnecting is an explicit owner decision.
Restart notices, files, errors and schedules retain their conversation route.
