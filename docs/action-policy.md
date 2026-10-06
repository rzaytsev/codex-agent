# Brokered action policy and approvals

The reviewed registry in `src/action-registry.js` supplies one strict schema,
roles, scopes, side-effect category, timeout, result-byte limit and retry class
for both MCP and direct `/tool`. Unknown actions, extra envelope/argument fields
and nested settings fields fail closed before execution. Owner, conversation,
session, actor, running task and group checks still apply at the service. MCP
advertisement narrows to the role/scope; hiding a tool is not the enforcement.
The observation bundle hashes actual JSON schemas and reviewed fixed metadata
for the effective advertised bundle and resolved policy version, never a capability
or SDK configuration.

| Actions | Roles | Scopes | Category / retry |
| --- | --- | --- | --- |
| history_search, history_read, task_status, location_get, memory_search, memory_read, memory_explain, memory_forget_preview, learning_read, learning_evidence, profile_read | main, worker, curator | conversation, read | read / safe |
| mail_agents, mail_inbox, mail_read, mail_status | main, DM only | conversation | read / safe |
| list_schedules | main | conversation, read | read / safe |
| memory_save | main, worker | conversation | local_modify / never |
| memory_forget, learning_feedback, profile_patch, profile_write, cancel_task, location_set_default, location_clear_temporary, cancel_schedule | main | conversation | local_modify / never |
| create_task, schedule | main | conversation | local_modify / request_key |
| send_voice | main | conversation | delivery / never |
| mail_send | main, DM only | conversation | prepare / never |
| mail_commit | main, DM only | conversation | external_send / committed_identity |

All actions have a 15-second service-operation timeout except send_voice (150
seconds); all result limits are 4 MiB. Async service calls receive the bounded
abort signal; cancellation cannot undo an effect already committed. A result
limit failure can occur after an effect, so it never authorizes automatic retry.
The existing 100,000-character request envelope bound remains. Retry metadata is
classification, not a generic retry executor. Read retries still recheck authority.

| Policy category | Default | Application enforcement |
| --- | --- | --- |
| read, prepare | automatic | strict schema, role/scope and route checks |
| local_modify | automatic | existing memory/profile/task/schedule permissions retained |
| delivery | automatic | existing service-owned response/voice delivery retained |
| external_send | confirm | mail_commit uses exact direct-owner approval |
| publication, purchase, delete, external_modify | confirm | no brokered operation implemented; unknown service actions denied |

`ACTION_POLICY` is a JSON object of category overrides. Automatic categories may
be set to `deny`; confirmation categories may be set to `deny` or `confirm`.
They cannot be promoted to automatic. For example,
`ACTION_POLICY={"external_send":"deny"}` disables brokered mail commit.
`ACTION_APPROVAL_TTL_SECONDS` defaults to 600, range 30–3600. The version digest
binds schema version, resolved matrix and TTL; a configuration upgrade invalidates
uncommitted approvals. This is a conservative service policy, not a universal
interceptor for generated code, browser actions, laptop mailbox CLI or third-party
tools. Local structured-memory forgetting remains an existing local_modify tool;
external deletion has no broker. No arbitrary approval token grants owner consent.

## Exact mail consent and recovery

mail_send validates/canonicalizes the bounded payload, stores a pending approval
and queues the exact payload, SHA-256 hash, expiry and command to the owner DM.
Its bounded returned summary flags truncated text; the service notification
contains the complete 12,000-character text and 200-character context. Preparation
sends nothing to the peer. The direct authenticated owner sends
`/approve APPROVAL_ID PAYLOAD_HASH` before expiry. Groups, forwarded envelopes
(including legacy forwarding fields), automatic forwards, bot senders, via-bot
commands and model/service approval calls cannot consent. Natural-language
consent and standing instructions do not replace this command.

mail_commit must include approval_id and the identical canonical mail payload.
The private ledger binds owner, DM route, session, scope, recipient, message ID,
kind, reply target, context, text hash, expiry and policy version. Changes invalidate
it. Consumption and insertion/linkage of the original idempotent mail outbox entry
commit in one SQLite savepoint. A crash rolls both back. Matching committed retries
return the original queue receipt without inserting a new send, even after its
approval expiry; they still check exact payload, route/session/scope and version.
That receipt describes the original commit, not current delivery. Use mail_status
for current transport state. `/new` invalidates old-session pending approvals.

Before a send begins, its durable state becomes inflight. A lost response or restart
becomes uncertain. Recovery only queries broker status and requires an exact
sender/recipient/kind/text/context/reply match before marking it sent. Missing,
conflicting or unavailable remote state remains uncertain; it is never resent
automatically. Deterministic broker rejections remain rejected. Existing receipt
and task-status operations retain their idempotent handling. This does not promise
exactly-once remote effects. Ledger/outbox audit rows have indefinite retention.

## Research and isolation gates

New research turns use read-only scope; requested conversation scope is refused.
Already persisted task settings/state and schedules are not rewritten; legacy
research settings are narrowed to read in memory when executed. The pinned
SDK 0.159.2 uses sandboxMode=read-only and approvalPolicy=never for research,
read-only and internal reviews. These turns clear configured MCP servers before
adding the read-only assistant bridge, disable apps/plugins/hooks/multi-agent
features, omit the Maps key and browser, and disable native project-document
reload. Internal reviews also disable web search. Research may use read-only web
search. Ordinary main/worker runs retain their runtime settings.

`READ_ONLY_WORKSPACE_PROTOTYPE=true` uses an empty disposable task cwd, removed
at the end of the turn; service DB, approval ledger and auth are not copied there.
Source data remains supplied through bounded prompt/context and read tools. The
existing CODEX_HOME authentication is retained for SDK compatibility. Neither
an empty cwd nor write denial isolates that readable authentication or other tasks.
Do not enable the prototype as a credential-isolation guarantee. Real ChatGPT
auth compatibility and the deployment OS sandbox require later authorized tests.

Run `node scripts/isolation-probe.js` against the installed pinned CLI. It creates
only temporary synthetic credential/foreign-task/write canaries and temporary
HOME/CODEX_HOME, runs no models/accounts/network calls, uses the actual built-in
`codex sandbox -P :read-only`, emits fixed booleans/enums and removes the files.
It reports protected, bypass or unavailable instead of silently falling back.
The built-in profile name was verified in the pinned
[protocol source](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/protocol/src/models.rs).

On the local macOS validation host, the nested sandbox returned unavailable
(sandbox_apply denied, exit 71). The approved disposable probe outside that
wrapper returned bypass: credentialReadable=true, foreignTaskReadable=true,
taskWritable=false. Credential isolation was not proved; live-auth compatibility
was unverified. This receipt covers this host/profile only, not a Linux image or
universal sandbox behavior. No host settings, real credentials or grants changed.

## Migration, backup and rollback

Startup adds action_approvals without rewriting existing tasks, schedules or
outbox rows. Retained legacy pending send rows become legacy and are blocked from flushing
until a fresh exact preparation and direct-owner approval atomically releases
the original row. Consent is never invented. Uncertain/inflight legacy operations
remain status-only and cannot be released for automatic resend. Existing inflight mail becomes uncertain; existing sent/rejected rows and
legacy pending identities are retained. Bounded ack/update receipts are unaffected. New preparation/commit behavior is an intentional mail
interface change. Custom workspace profiles stay intact; the application-owned
turn instructions explain the current contract even for older messaging sections.

Back up the canonical database, workspace and auth consistently before rollout.
The ledger contains private payloads; protect it like history. Keep ledger and
mail_outbox in the same SQLite snapshot. No extra mount, automatic GC or collector
is introduced. Stop execution/delivery before rollback: older code can bypass
approval and blindly retry old pending transport calls. Reconcile pending and
uncertain operations first. Additive tables can remain with older source, but
its missing controls must be accepted explicitly; a complete state rollback uses
the matching pre-upgrade snapshot and also reverts later history/delivery state.
Do not mix approval/outbox tables from different snapshots.
