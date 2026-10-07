# Personal agent across Telegram conversations

One bot serves one configured owner. The DM and linked groups are topic-specific
conversation threads for that owner. Groups do not create another agent, owner,
knowledge base or permission boundary. Replies are visible to all group members,
but only the configured owner can submit instructions, before persistence/download.

## Delivery milestones

1. Replace isolated group knowledge with one canonical owner database and profiles.
2. Preserve independent main sessions, recent context, queues, settings and routes.
3. Migrate old group records, evidence, rollouts and forgetting without deletion.
4. Verify shared recall/rules/tools, owner checks, concurrency and source delivery.
5. Build/test the Linux image; deploy each instance with snapshots and preservation
   checks, then verify actual installed behavior and model recall before publication.

## Shared knowledge and independent context

`state/assistant.sqlite` owns all history, inputs, jobs, schedules, outbox, memory,
learning and provenance. Conversation IDs scope orchestration queries and metadata;
owner knowledge remains shared. `AGENTS.md`, `SOUL.md`, `USER.md`, generated learning,
skills, projects, source files and account integrations are shared across chats.
The Codex home/authentication is shared within the instance, isolated from other owners.

Each conversation has a stable UUID, Telegram chat ID, optional reserved thread ID,
lifecycle state, settings and replaceable main session. Recent history and task status
are local to that conversation. History tools default to it; explicit `scope=all`
retrieves other owner conversations when relevant. Relevant memory and learning are
retrieved globally. Sharing availability does not inject all transcripts into every turn.

A rule or preference changed in one chat applies to subsequent turns everywhere.
One owner maintenance schedule consolidates evidence across chats. Forgetting is
owner-wide for structured memory and sourced learning; transcripts/files/backups
retain their documented separate retention. Workers cannot change profiles, spawn
workers or widen their parent's tool scope. Curators remain read-only.

Owner group turns use the same workspace, configured browser, Python, skills and
integrations as DM turns. The separate group executor/broker and named sandbox
introduced for multi-participant access are retired. Isolation between different
bot owners remains. Normal model code retains the instance's granted filesystem
and account access; conversation routing is not a filesystem security boundary.
Authentication challenges and mailbox acceptance remain in the owner DM.

## Migration and recovery

Migration imports each old group database once, in a canonical-database transaction.
It remaps history IDs and evidence, preserves session/thread IDs, task settings,
outbox states, memory revisions, tombstones and learned records. Old databases,
profiles and group files remain intact under their existing paths. Saved Codex
rollouts move into the shared home through collision-checked copies; credentials
and old neutral group rules are not copied over the owner configuration.
Conflicting memory keys are archived under deterministic distinct keys; conflicting
learned rules are retired rather than overwriting owner rules. Forgotten root keys
are never revived by migration. Inspect conflicts through the database/archived
memory tools before deliberately reconciling them.

Legacy maintenance schedules are disabled so only the owner loop consolidates.
Ordinary queued work retains its source. Other participants' pending inputs/jobs
cannot execute after the owner-only transition. Interrupted execution and uncertain
sends retain the no-blind-replay contract. Backup snapshots include the canonical
DB and any retained legacy DBs; new groups need no separate database file.

## Intake and controls

Link with `/link@BOT_USERNAME` directly in the chosen group as the owner. Group
messages require an entity-based direct mention or `/command@BOT_USERNAME`.
Unmentioned messages, other participants, bots, unknown groups, edited messages
and forum topics are discarded. Replies without mentions remain unsupported.
For plain mentions, disable privacy in BotFather and re-add the bot, or make it
an admin. Privacy-enabled bots receive addressed commands; plain mentions are
not guaranteed. See [Telegram privacy](https://core.telegram.org/bots/features#privacy-mode).

`/group` in the DM lists linked groups; `/group disconnect ID` blocks their route;
`/group settings ID {"effort":"medium"}` changes their defaults. `/group share ID
selected text` sends selected text to that group; shared memory needs no share step.
Settings resolve instance defaults, conversation settings, then task overrides.
`/new`, `/status`, `/stop`, `/cancel` remain conversation-specific. Late task results
return to their original chat without entering a newly reset session's context.
Disconnecting blocks execution and delivery, with no redirect to another chat.

Cancellation requested by `/stop` or `/cancel` remains active until owned-process settlement. Recovered unknown cancellations reserve shared capacity; a missing in-memory controller is not exit proof. No late final response is queued. See [task outcomes](task-outcomes.md).

## Acceptance

Save a fact/preference in the DM and recall it in two groups. Change a rule in one
group and observe it in the other. Recent discussion and `/new` stay local; shared
memory survives resets and restarts. A group A task must finish only in A while
B and the DM are active. Test other-participant rejection, migration retry,
revision conflicts, forgetting, account availability and bounded fair concurrency.
Source tests, image tests, installed-state checks, isolated real-model tests and
actual Telegram interactions are distinct stages of evidence.
