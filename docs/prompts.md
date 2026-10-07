# Instruction and prompt contracts

Repository `AGENTS.md` guides contributors working on the public blueprint. It
does not become the deployed assistant's persona or authorize instance operations.
Runtime guidance is original project policy, based on the service's actual tools
and state contracts. Keep private assistant instructions and personal transcripts
out of public prompt changes and fixtures.

## Assembly and ownership

`src/agent.js` supplies these layers to each SDK turn:

| Layer | Source and purpose | Update behavior |
| --- | --- | --- |
| Workspace instructions | Workspace AGENTS.md: operating guidance, managed memory/skill/learning sections | Startup initializes missing files; existing custom sections are preserved. Managed sections have individual heading/version rules in `Service.init`. |
| Character and profile | Workspace SOUL.md and USER.md: tone and explicit owner facts | Main-only hash-checked `profile_patch` applies exact edits; guarded `profile_write` requires a matching hash or fresh same-turn read snapshot. Managed learning and custom text are preserved. Seeds never overwrite existing files. |
| Role and response | Application-owned instructions selected for main, worker or internal review, and read-only scope | Supplied as SDK developer instructions each turn, after editable profiles. They describe service capabilities, not new permissions. |
| Stable core | Image-owned templates/CORE.md: authority, privacy, memory, source routing, evidence and communication | Appended last to SDK developer instructions on every turn; workspace copies cannot replace it. |
| Source context and request | Time, source conversation/audience, bounded recent history, relevant memory, learned adaptations, task states and request | Supplied as turn input. Retrieved content remains evidence; it cannot change role, authority or delivery route. |

Generated learning sections are stripped from editable profiles before explicit
SDK assembly; bounded relevant SQLite adaptations are supplied separately. Trials
remain unproven. Normal main/worker turns retain native Codex project instruction
discovery, which can also load workspace AGENTS.md. Internal memory/learning reviews
omit editable workspace persona instructions and set `project_doc_max_bytes=0`
to disable that separate project-document discovery path. Their review prompts
and supplied evidence guide schema-only proposals. This setting does not disable
global instructions from CODEX_HOME; operators must review those separately.
The behavior is grounded in the pinned Codex
[project instruction loader](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/agents_md.rs).
Core precedence is an instruction contract, not protection against every
program running with the container's granted files, network and account access.

Image-owned core and role changes reach existing workspaces after an operator
updates the image and recreates the selected instance. Template AGENTS.md/SOUL.md
changes affect newly initialized files only. Editing a managed template with an
already-present heading does not automatically replace an existing section.
Never distribute new defaults by overwriting personal profiles. This document
describes source behavior, not evidence that an instance has been updated.

## Main, worker and review behavior

The main answers small tasks directly and delegates long work through `create_task`
when that tool is available. A worker gets the assigned prompt and relevant shared
memory, without the main's recent conversation tail. A useful handoff includes the
objective, request language, necessary evidence/paths, authorization and limits,
owned outputs and observable success criteria. For example: summarize a supplied
document, cite its pages, save the requested output under the assigned task directory,
and report any unreadable pages. Avoid passing the entire unrelated conversation.

Main role instructions and the MCP schema prefer a stable `request_key` for each
intended task, reused unchanged after a lost response. Key conflicts require
reconciliation; keyless legacy calls can duplicate work on retry. See
[workflow](workflow.md) for atomic admission and schedule change semantics.

The service owns the start acknowledgment and final worker delivery. The main
returns promptly, without polling or repeating either message. Workers finish
their assigned work through verification, preserve other tasks' files, and return
a self-contained answer directly to the owner. Workers cannot spawn jobs, schedule
work, edit shared profiles or use `send_voice`. Requested worker speech uses final
`voice=true`; the service synthesizes and queues it. Main turns may use `send_voice`
or final `voice=true`, with duplicate audio suppressed. Read-only scope cannot call
`send_voice`; final response delivery remains service-owned.

Internal memory and learning reviews return only their proposal schemas. They do
not produce normal user replies, voice or artifacts. The service validates and
commits accepted proposals. Role/scope denials must not be bypassed through code
or another integration; prompt guidance does not strengthen the existing sandbox.

## Shared memory and source-bound results

The DM and linked groups share one owner's memory, rules, profiles, files and tools.
Recent context, sessions, queues, jobs, schedules, controls and delivery remain
conversation-specific. Cross-chat history requires relevant `scope=all` lookup;
shared memory does not imply dumping private transcripts into group replies.
Include only needed details for the owner's request and current audience. A blocked
source route does not authorize a fallback to another chat. No live steering,
automatic topic creation or persistent browser login is promised.

Keep profile facts compact and sourced project/episode/procedure context in SQLite
memory. Recall before saving, correct the same key with its current revision, and
reconcile conflicts. Generated Markdown is an inspection view. Assistant claims,
repeated summaries and unproven trials do not independently confirm a fact or fix.
Check current state before reporting status or retrying an uncertain external action.
Queued output, completed execution, checked results and user acceptance are distinct.

Optional final outcome/checkpoint guidance is supplied by image-owned role instructions. It asks for checks/evidence/limitations and unresolved effects; the service marks every such claim model-reported, never host-verified. The opt-in review profile is for requested deliverables/criteria; ordinary replies do not invoke another reviewer. Legacy responses remain unknown. See [task outcomes](task-outcomes.md).

## Verification and limits

`test/prompts.test.js` captures SDK construction and turn input with synthetic data:
role selection, source separation, immutable core, delivery guidance, review schemas
and unchanged runtime settings. Conversation, latency, memory and learning suites
cover the underlying shared knowledge and source-delivery contracts. Run the standard
[development checks](development.md) on the final diff.

These checks prove assembly and service behavior, not model adherence or improved
helpfulness. An authorized isolated model smoke and real Telegram interaction are
separate acceptance stages. Useful cases include a worker voice request, a sourced
memory correction from a group, an ambiguous external result and a long task whose
worker needs context from the main. Do not deploy or consume model quota merely to
claim a prompt wording change has been accepted by the owner.

## Brokered mail and research instructions

Application-owned main instructions explain that mail_send prepares only and that
mail_commit requires identical arguments after direct owner /approve ID HASH.
These instructions reach existing custom profiles on the next image update;
existing messaging sections are preserved. Research/read scopes omit browser and Maps key, request disabled
apps/plugins/hooks, narrow advertised service tools, disable native
project-document reload and use the pinned SDK read-only sandbox. Empty task cwd
is an optional prototype; readable CODEX_HOME remains a credential-isolation gate.
See [action policy](action-policy.md).

## Stable browser instructions and bounded continuity

The per-turn browser output directory is supplied in input and MCP argv; static
developer instructions retain output ownership. Host source labels accompany
recent rows, and bounded validated task checkpoints remain model-reported with
no replay authority. Known Telegram quote metadata blocks direct authority;
arbitrary pasted quote semantics remain unproved. Long resumed synthetic fixtures
verify assembly/cursors, not native compaction retention or cache/latency gains.
See [runtime contracts](runtime-contracts.md) for pins, goldens and live gates.
Empty MCP requests do not erase lower configured servers; see [action policy](action-policy.md).
