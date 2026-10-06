# Brokered action policy and approvals

Stage A registry, approval ledger and workspace prototype are implemented source
functionality pending independent acceptance. Full compatible credential and
foreign-task isolation is **incomplete and blocking**: the actual canary bypass
is narrowed only by the disabled restricted-profile research prototype below.
Neither prototype fulfills the full isolation requirement.

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
uncommitted approvals. Contract version 2 also invalidates uncommitted approvals
prepared under the earlier markup-rendered preview; reprepare deliberately with
a fresh message ID and obtain fresh exact owner consent. Rows and already
committed outbox/audit data remain retained. This is a conservative service policy, not a universal
interceptor for generated code, browser actions, laptop mailbox CLI or third-party
tools. Local structured-memory forgetting remains an existing local_modify tool;
external deletion has no broker. No arbitrary approval token grants owner consent.

## Exact mail consent and recovery

mail_send validates/canonicalizes the bounded payload, stores a pending approval
and queues the exact payload, SHA-256 hash, expiry and command to the owner DM.
Its bounded returned summary flags truncated text; the service notification
contains the complete 12,000-character text and 200-character context. Approval
envelopes use a persisted service-owned plainText mode, bypassing Telegram markup
so backticks, asterisks, HTML-significant characters and JSON escapes remain
literal across chunks. Normal replies keep their formatting; model results and
service-tool arguments cannot set this delivery flag. Preparation
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

### Disabled restricted-read profile prototype

`RESTRICTED_READ_PROFILE_PROTOTYPE=true` selects application-owned exact permission
config through SDK overrides for research, read-only and internal review attempts.
Ordinary main/worker runs retain their existing permissions and continuity. Every
selected attempt starts a fresh SDK thread and empty mode-0700 cwd outside service
and auth roots; it never reads/resumes/updates the ordinary main thread or its
history cursor. A fresh profile name avoids lower-layer same-name config merging;
there is no application/task directory/input grant, wildcard, write grant, operator
root list or fallback to built-in/danger mode. Local images are refused and assembled
request/developer instructions are each bounded to 100,000 characters. Context
comes through the host's bounded history/memory and scoped service read broker.
Fresh restricted IDs may be retained in audit/jobs, but are never auto-resumed.

The selected profile grants `:minimal` plus the canonical exact Node executable
(`realpath(process.execPath)`), and on macOS the exact public runtime dependency
`/System/Library/OpenSSL/openssl.cnf`. It sets network.enabled=false for raw shell
execution, disables web search/browser/apps/plugins/hooks/subagents, and keeps only
the read-scoped assistant MCP bridge. Shell environment policy inherits none and
sets only PATH=/usr/bin:/bin and LANG=C.UTF-8. The privileged SDK/model parent still
uses the existing ChatGPT HOME/CODEX_HOME and auth; Python environment overrides
and Maps credentials are omitted for restricted attempts. Parent/auth/MCP bridge
compatibility has not been tested with an account. This is not a network boundary
around that privileged parent or its authorized broker.

Codex SDK/CLI 0.159.2 emits a legacy `--sandbox` flag when sandboxMode is supplied;
that override selects legacy permission syntax over custom profiles. The prototype
omits sandboxMode. A valid persisted profile also precedes configured default
permissions, so fresh threads are required rather than assuming SDK `-c` wins on
resume. Actual-SDK synthetic child tests check both emitted argv conditions without
running a model. Observation bundle hashes include only fixed reviewed permission
metadata, beside the effective read registry; runtime paths, profile IDs, credentials
and raw config/environment are excluded.

macOS `:minimal` is a platform runtime baseline, **not a list of harmless public
files**: it includes system config/library/preferences directories and IPC helpers,
including /etc, /private/etc, /var/db, /Library/Preferences, library/runtime roots,
standard executables/devices and selected system services. Review the pinned
[platform policy](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/sandboxing/src/seatbelt_read_only_platform_defaults.sbpl)
and exact target roots/content before opting in. No real system credentials or
host services were inspected. Allowed system content and IPC remain limits.

### Disposable actual-CLI canary

Run `node scripts/isolation-probe.js --mode=builtin` (also the default) or
`node scripts/isolation-probe.js --mode=restricted`. Both create only temporary
synthetic HOME/CODEX_HOME, service/approval/credential/foreign fixtures, links and
an exact owned sibling PID. No model/account/network call or host configuration
change occurs. Restricted mode alone adds an exact owned single-link regular
input file as a positive read control; this grant is probe-only and is absent from
runtime attempts. Symlink/multilink inputs are refused before a grant. A fixed
stdin/stdout handshake creates a foreign file after the sandbox starts. All writes
are attempted only against synthetic fixtures. `/bin/ps -p OWNED_PID -o command=`
checks one known process argument route, with an outside positive control; no
process inventory or real environment is read. Ambient env is excluded and the
child validates absence of known credential/env-canary keys. stdout parses only
bounded exact booleans; stderr/error/config/paths/environment are never emitted or
stored. Finally cleanup stops the sibling and removes all fixture roots, including
unavailable/failure exits.

Local macOS, Node 24.21.0, CLI 0.159.2: nested wrapper **unavailable**, exit 71.
Approved outside-wrapper builtin comparison **bypass**: allowed input and synthetic
credential/foreign/symlink/hardlink/late/service/approval reads succeeded; writes
were denied. Restricted comparison **protected for these fixtures**: allowed input
read succeeded; all listed denied reads/writes failed, sanitized child environment
passed, owned-PID argument read failed, and late/process positive controls passed.
`credentialIsolationProved` in that receipt refers only to these disposable
fixtures on this host/profile. An initial restricted run used an overstrict HOME/
CODEX_HOME presence check; accepting absent or exact disposable paths reflects the
profile's inherit-none behavior. It was rerun successfully. No raw diagnostics were
persisted. This does not prove all process-memory/proc/IPC/native filesystem routes.

Full compatible isolation remains **INCOMPLETE AND BLOCKING**. Linux target-image
shell/native canaries, process-env/proc/native filesystem/skills/tool review and
opt-in authenticated ChatGPT+MCP compatibility remain unverified; no Docker daemon
is available locally. Ordinary main/worker code keeps existing danger grants and
can modify other task files. Same-grant outside writers can replace a permitted
pathname after validation; removing runtime application-input grants avoids that
particular grant, not mutual worker isolation. Do not expand autonomy or enable this
option as production acceptance. The next gate is synthetic target-image validation,
then separately authorized authenticated compatibility.

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


The restricted-read option changes no schema, persistent tasks, schedules, profiles,
account config or existing ordinary thread/cursor. It creates no backup root and
copies no DB/ledger/auth into temporary cwd. Preserve existing consistent database,
workspace and CODEX_HOME backups before an eventual opted-in rollout. To roll back,
stop/drain restricted attempts, reconcile interrupted work and any uncertain external
operations, set RESTRICTED_READ_PROFILE_PROTOTYPE=false and restart the selected
instance. Do not automatically replay a failed attempt under broader permissions.
Disabling retains fresh restricted audit/job IDs but does not resume them; ordinary
continuity is unchanged. No state restoration is required for this prototype alone.
