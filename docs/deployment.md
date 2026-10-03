# Deployment and multiple agents

For inter-instance and laptop communication, opt into the separate
[agent mailbox](agent-messaging.md), preserving existing instance mounts and
Compose project identities.

## Public source and private instances

```text
private/instances/NAME/
  agent.env                  credentials, owner, timezone, models and host paths
  compose.override.yaml      optional extra mounts and deployment settings
  seed/                      optional USER.md, SOUL.md and AGENTS.md
private/shared-skills/       optional mutable skills shared explicitly
private/operations/          private host settings, migration notes and archives
```

The entire private directory is excluded from Git and Docker build contexts.
Keep it protected and backed up. Each instance gets its own Compose project,
Telegram token, owner, workspace, Codex authentication and sessions. The common
image contains application code and generic templates. No host ports or Docker
socket are exposed by the base configuration.

## Create and start

From the source checkout with Node.js 24+:

```sh
./bin/agent create demo --data-root /srv/agent-data
```

The generator refuses an existing instance. It creates private directories and
an owner-readable env file; it does not create runtime directories or credentials.
Set TELEGRAM_BOT_TOKEN, exactly one TELEGRAM_ALLOWED_USER_IDS value and TIMEZONE
in private/instances/demo/agent.env. UTC is the public default. Use a distinct
bot token and data paths for every instance. Empty Telegram settings start in
setup mode without Telegram requests; multiple owners are rejected.

On the target Linux Docker host, provision the configured persistent directories:

```sh
install -d -m 700 /srv/agent-data/demo/workspace /srv/agent-data/demo/codex
./bin/agent config demo
./bin/agent up demo
```

The launcher works from any current directory. It always selects the base
Compose file, the chosen private env file, its optional override, and the stable
project name codex-agent-NAME. Its config command validates quietly, avoiding
resolved credentials in terminal output. Container mounts fail if required host
directories are missing, instead of silently starting with empty persistence.
The Linux host only needs a POSIX shell and Docker for launcher operations;
creation requires Node. Transfer private configuration separately when needed.

Send /start in the bot's private chat. If signed out, it sends a device-code link
and code; complete authorization in your browser. Use /auth to switch accounts,
/auth status to check, or /auth cancel. Authentication remains in the selected
Codex mount. Never copy desktop authentication or paste credentials into chat.
No API-key fallback is provided. See [authentication](authentication.md) for
active-work handling, recovery, and the operator login fallback.

## Personal instructions and source mounts

Before the first start, optionally put USER.md, SOUL.md and AGENTS.md in the
instance's seed directory. Only these three files are used; each is copied only
when its workspace counterpart is absent. Generic templates fill missing seeds.
The workspace files become authoritative and remain editable by the agent.
The separate `seed/plugins.json` is an operator-managed desired plugin list,
read directly after login on startup; it is not a profile seed. See
[configuration](configuration.md#desired-plugins). New instances receive an empty
list. Existing instances can add the file without changing mounts. Remote-catalog
installation runs at runtime, since build has no instance login and the Codex
home bind mount hides image-built files at that path. Do not bake authentication
into the image.
Seed changes do not replace existing profiles. Managed runtime policy sections
are still appended/updated by startup. Seed files are mounted read-only into only
that instance, never copied into the image. Personal context imports belong in
the private instance directory and require deliberate execution.

Copy examples/compose.sources.yaml to the instance's compose.override.yaml to
add personal source mounts. Use absolute host paths or paths relative to the
repository root: Compose overrides resolve relative paths from the base file.
Mount source documents read-only unless writes are intentional. Never mount the
entire private directory into a bot. Source mounts are explicit access grants.

Public shared-skill mounts are read-only. Put learned or personal skills in the
workspace's .agents/skills directory under distinct names. To customize a bundled
skill, keep a private copy and override that specific mount. Private shared copies
are available only to instances that explicitly mount them. Review changes before
promoting any private skill into public source.

## Updates and health

```sh
./bin/agent up demo --force-recreate
./bin/agent ps demo
./bin/agent logs demo --tail 30 assistant
./bin/agent exec demo assistant node -e "fetch('http://127.0.0.1:8765/health').then(r=>r.json()).then(console.log)"
```

Up builds and starts in detached mode; pass --no-build to select an already
validated image. Recreating applies env changes; restart
alone does not. Preserve the instance name and existing host paths when updating.
A healthy setup-mode container is not a configured assistant. Health distinguishes
setup:telegram, setup:codex-login, setup:codex-login-pending, ready and
degraded/stopping states (including degraded:codex-auth). Actual
Telegram replies and account tool access require separate acceptance checks.

Review logs privately: operational output can include task context. Protect both
workspace and Codex persistence. See [backups](backups.md) for consistent SQLite
snapshots, encrypted backups and restore. Keep source sync separate from runtime
data, and preserve private configuration during checkout replacement.

## Host permissions

Bind mounts do not bypass host ACLs. On Linux,
`scripts/prepare-shared-skills.sh --snapshot-dir /var/lib/codex-agent/acl-backups`
can grant UID 0 read/search access after a sync when explicitly authorized. It
preserves other identities' effective rights and saves a rollback ACL snapshot;
it does not grant group writes or make public skill mounts writable. For private source trees,
scripts/prepare-source-access.py accepts explicit roots and --snapshot-dir; it
preserves other identities' effective permissions and records prior ACLs.
Inspect source permissions before running either host mutation helper.

## Voice and attachments

For the owner's other Telegram chats, the image includes tdl and the shared
telegram-read skill. Use `/tdl_auth` in the owner conversation for QR login, or
`bin/agent tdl-login NAME` on the host for phone/code/2FA login. Session data lives in the existing persistent workspace;
no credentials are included in the image. See [Telegram reading](telegram-read.md).

Voice input uses local faster-whisper on CPU. Its model is downloaded on first transcription and cached under the Codex host mount. Choose WHISPER_MODEL and optional WHISPER_LANGUAGE in the instance env. The first download may take time and needs network access. The main agent can call `send_voice` with the text to speak; it generates and queues a Telegram voice message for the requesting user. Workers cannot send voice directly. The structured `voice=true` reply remains supported. Successful tool output means queued, not confirmed delivery. Voice output uses local eSpeak NG and FFmpeg to produce OGG/Opus; it is synthetic/robotic, not a natural neural voice. Set TTS_VOICE (for example en, es, or ru). No OpenAI API key or separate speech API billing is used.

Original media, captions and forward metadata are saved in inbox/. PDF text is extracted with pdftotext; scanned PDFs can be rendered/OCRed by the agent using installed tools. Images are supplied as local image input to Codex. Standard Bot API download limit is capped at 20 MiB here; larger attachments receive an error. Media albums are separate messages in this initial version. Unsupported file formats are preserved for tool/code processing.

## Separate group executors

The optional host broker enables COD-1 groups while preserving the personal
container's security settings. Review [conversation boundaries](conversations.md)
and copy [the broker configuration](../examples/group-executors.json) to
`/etc/codex-agent-group-executors.json` with mode 0600. Select existing workspace
paths and a verified immutable image tag/digest. Install
[the systemd unit](../systemd/codex-agent-group-executors.service), adapting only
its source-checkout path, and start it on the Docker host. The broker creates
`state/executors/control.sock` inside each existing workspace mount. Add
`GROUP_EXECUTOR_SOCKET=/workspace/state/executors/control.sock` to selected
private instance env files before recreation. No Docker socket is mounted into
the assistant and no personal mounts are added to executors.

Before production, use `scripts/group-executor-smoke.js` in a dedicated synthetic
workspace with its own broker config; `GROUP_EXECUTOR_SMOKE=1` is required.
The default smoke checks the real executor without a model or Telegram request.
`--model` additionally consumes one model turn through a deliberately mounted
existing Codex login in the client container; no auth is mounted into executors.
It exercises native commands, group file creation and scoped MCP. Real Telegram
linking, mention intake and source-only delivery remain a separate acceptance.

## Telegram command menu

On startup, configured bots replace the default-language command menu with `/help`, `/auth`, `/tdl_auth`, `/usage`, `/status`, `/new`, `/cancel`, `/stop`, and `/location` using Telegram `setMyCommands`. Registration covers the default scope, all private chats, and each allowlisted private chat, so older menus in those scopes are overwritten. It runs independently of Codex login. Failures are logged without private details and retried after at least a minute while polling continues. Language-specific menus previously configured in BotFather are not reset by this registration; remove those overrides there if they still appear. Ordinary messages wait for login when signed out; `/start` then starts login. With saved login, `/start` reaches the assistant.

## Saved Telegram locations

Direct location messages from an allowlisted private-chat user are saved atomically
in `/workspace/state/locations/<user-id>.json` (mode 0600). Defaults and temporary
locations are separate, survive container recreation, and are scoped per user and
instance. Live-location edits update the temporary entry quietly. Forwarded pins
do not automatically replace it. Location intake works without a Codex model turn.

- Share a Telegram location to set the temporary override.
- `/location default` makes a fresh temporary location the usual/default location.
- `/location clear` removes only the temporary override.
- `/location` reports which source is active.
- Natural-language default-location changes use the assistant's
  `location_set_default` MCP tool with supplied or disambiguated coordinates.

`location_get` selects the temporary location for strictly less than 12 hours
from Telegram's message/edit timestamp, then the default. Delayed delivery does
not make an old pin fresh. At exactly 12 hours it falls back; if no default exists,
the agent asks. An explicit place in the current request takes precedence. No
default coordinates are invented or preconfigured. Workers can read locations
but cannot use the MCP mutation tools. Clearing does not erase original intake
or backups. The image contains a location-instruction migration that preserves
custom AGENTS.md content and adds these rules once to existing workspaces.

## Shared assistant workflows

The shared `learn`, `scrape`, `skillify`, `investigate` and `planning` adaptations
are mounted read-only for every instance alongside project-manager and Google
Maps. They use Chromium and the existing worker/uv tools. Startup adds their
routing instructions to custom AGENTS.md once. See [shared skills](shared-skills.md)
for invocation, private generated artifacts and the discovery smoke check.

## Memory consolidation

Versioned memory lives in the existing persistent SQLite database, with generated
Markdown under `memory/facts/`, `memory/projects/`, `memory/episodes/` and
`memory/procedures/`, with `memory/INDEX.md`. Each instance has one owner.
Existing profiles and legacy notes are preserved. Startup updates the managed
capture/recall section of AGENTS.md once and migrates old nested projections into
the flat layout, retaining their original tree in a state-directory backup.
Defaults schedule daily consolidation at 03:15 and weekly consolidation Sunday
03:45 in TIMEZONE, separately from cleanup and user-facing reflections. Both run
quietly when idle and yield to conversation. See [memory](memory.md) for tools,
backlog/coverage limits, backups and per-instance environment overrides.

## Chromium browser

The image installs Debian Chromium and pinned `@playwright/mcp` 0.0.83. Every main/worker turn starts its own stdio browser MCP server with headless Chromium and an isolated in-memory browser context. There are no browser ports exposed. `BROWSER_ENABLED=false` disables the integration; `BROWSER_EXECUTABLE` defaults to `/usr/bin/chromium` and can select a local installation for development.

Navigation, rendered-page inspection, clicks, forms, downloads and screenshots are available through browser MCP tools. Outputs belong under `/workspace/outputs/browser/<turn-id>/` and persist in the workspace host mount. Agent instructions require actual screenshot files and returning their paths for delivery. PNG/JPEG files up to 10 MiB are sent as Telegram photos; Telegram image-size/dimension rejections fall back to documents. Larger images and other file formats remain documents.

Contexts are isolated between simultaneous workers and instances, and reset between turns. Site cookies/logins do not persist automatically in this first implementation. Logged-in browsing and interactive CAPTCHA/2FA handoff remain future work; agents must report those barriers honestly. Container-root Chromium uses `--no-sandbox`; the existing Docker restrictions remain, with 512 MiB shared memory and a 512-process limit for Chromium subprocesses.

Rebuild and recreate both named instances after source sync. Browser smoke validation is `node scripts/browser-smoke.js` inside the image: it exercises a real local web page, a link click, PNG capture and two independent browser sessions. This does not invoke a model or send Telegram messages.

## Usage limits

`/usage` reads live account limits through the installed Codex app-server `account/rateLimits/read` endpoint over a short-lived stdio process. It uses this instance's existing ChatGPT login, does not make a model call, and can run while model login is unavailable (reporting that limits could not be read). It prefers the multi-bucket response, shows each reported window's remaining percentage and reset timestamp in the instance TIMEZONE, and distinguishes missing information from zero usage. These are account limits shared by agents signed into that account.

Explicit Codex quota-exhaustion errors, including streamed `turn.failed` / `error` events and thrown SDK exceptions, produce a Telegram notice with freshly fetched limits/reset times. Main messages and worker jobs stay failed; external actions are not automatically retried. Generic HTTP 429 and context-window failures are not treated as exhausted subscription usage. If account lookup fails, the notice states that reset times are unavailable and points to `/usage` / Codex usage settings. The lookup never consumes an earned reset or purchases credits, and excludes raw error text, account IDs and credentials from output.

Changes require rebuilding and recreating the named containers; command registration runs at their next startup.

## Document/data tools and uv

The image adds Pandoc, headless LibreOffice Writer/Calc/Impress, ripgrep, jq,
zip/unzip, process inspection and C/C++/Python build tools. Python's baseline
Pillow, pandas, openpyxl, matplotlib, python-docx and python-pptx versions are
pinned in requirements-tools.txt. Existing browser, PDF/OCR, speech and media
tools remain available.

uv 0.12.21 comes from Astral's official image and manages Python installs/venvs.
Startup creates `/workspace/state/python` with system-site-packages, inheriting
the image's baseline libraries. This default writable venv persists with the
workspace and is validated/reused without deleting added packages. Model tools
get its bin directory on PATH, VIRTUAL_ENV and persistent uv cache/tool/Python
paths. The speech interpreter remains separate in the read-only image.

```sh
uv pip install --python /workspace/state/python/bin/python PACKAGE
uv venv --python /usr/bin/python3 /workspace/projects/NAME/.venv
uv pip install --python /workspace/projects/NAME/.venv/bin/python PACKAGE
```

For reusable projects use pyproject.toml, uv.lock and `uv run --project ...`.
Explicit interpreter paths avoid installing into the wrong environment. Uncached
packages require network access; native packages may require system libraries
added to the image. uv's copy link mode keeps installs independent of cache
removal. Image Python upgrades can invalidate persisted venvs; startup fails
rather than deleting user packages silently. Back up dependency declarations
and rebuild affected environments with uv when needed.

LibreOffice needs a unique writable profile, for example:

```sh
libreoffice -env:UserInstallation=file:///tmp/lo-TASK --headless --convert-to pdf --outdir /workspace/outputs /workspace/outputs/report.docx
```

The repository's project-manager skill is mounted read-only from
`shared-skill/project-manager` into every instance's `.agents/skills/` directory.
ORIGIN.md records the public distribution provenance. Startup appends tool/artifact/skill
guidance to existing AGENTS.md once, preserving custom content.

After startup, the built-image smoke check is:

```sh
./bin/agent exec demo assistant /workspace/state/python/bin/python scripts/tooling-smoke.py /workspace/outputs/tooling-smoke-NEW-ID
```

Use a fresh output directory. It creates and reads back PNG, XLSX, DOCX and PPTX,
converts Markdown through Pandoc and DOCX to PDF through headless LibreOffice,
then checks PDF text. It sends nothing to Telegram.

## Artifact delivery

Main and worker responses return existing workspace paths in `files`. Worker
text and validated files are queued immediately on completion without a main-model
follow-up. PNG/JPEG up to 10 MiB use sendPhoto with document fallback;
PDF, DOCX, XLSX, PPTX, ZIP and other formats use sendDocument with filenames/MIME
types preserved. The local limit is 49 MiB. Invalid/missing/oversized paths get an
explicit notice. Duplicates in one response are collapsed. The existing
allowlisted queue retains failed/uncertain states; queued is not delivered.

## Daily workspace cleanup

`CLEANUP_ENABLED=true` and `CLEANUP_CRON=0 3 * * *` enable one persisted agent job
per instance at 03:00 in TIMEZONE, independently of proactive reflections. The
first allowlisted user owns its notifications. It is seeded at startup, waits
for model login and idle workers, and skips overlapping runs. An incoming user
request interrupts cleanup before another model turn starts. Reports obey quiet
hours; interrupted runs are not automatically retried.

The agent follows templates/CLEANUP.md: inspect usage and running work, use
`uv cache prune`, and remove clearly disposable old task scratch/cache files
and reproducible unused task venvs. Temporary items need 7 days of age, task
venvs 30 days. Profiles, auth, state/default venv, history, databases/WALs, memory,
uploads, source/project files/environments, backups, deliverables, shared skills
and pending/uncertain deliveries are preserved. Unknown candidates are retained
and suggested for review. Measured results are saved in memory/cleanup/.
This instruction policy guides the fully autonomous model; filesystem access is
still defined by container mounts, not a dedicated deletion sandbox.

Set CLEANUP_ENABLED=false to disable it. MCP schedule cancellation survives
restarts. Changing cron/timezone/owner or toggling the env flag back on
reconfigures it; `list_schedules` exposes its ID. Actual cleanup decisions/deletes
have not been exercised in production.

See [Google services](google-services.md) for connections, installation commands
and verified container tool availability.

## Telegram working feedback

Response-latency updates require rebuilding the selected image and recreating
the instance. Existing history and model threads are retained; the first resumed
turn initializes its history cursor. Ordinary worker answers now go directly to
the outbox, so verify a completed task arrives while the main conversation is
busy and remains available to a follow-up question. Preserve configured worker
reasoning; `MAIN_REASONING=low` is the default for faster conversational turns.
Model timing probes consume subscription quota and do not prove Telegram delivery.
Committed replies wake delivery immediately once authentication and routing
initialization finish. Verify queued-to-sent timing separately from model time;
typing and upload indicators must not add a blocking Telegram request.

The service refreshes Telegram sendChatAction typing every four seconds while
preparing a reply, and shows upload_photo/upload_document/upload_voice during
artifact delivery. These indicators are best effort and never replace the
durable result; their API failures don't fail a real message upload.

User turns show typing without sending an automatic working acknowledgment.
Background tasks send the short natural `create_task` acknowledgment supplied
by the main agent, in the language of the current request, without a task ID or
English status wrapper. Task IDs and titles remain available through /status.
Older tasks without an acknowledgment start quietly; scheduled reflections and
cleanup avoid routine start notices.
Messages received during a current reply remain pending without an automatic
queue notice. This behavior applies to every instance without a configuration flag.
To update existing instances, build the updated shared image and recreate each
selected instance with `bin/agent up NAME --force-recreate`, preserving its project
and mounts. Restart alone retains the old image. Verify each bot with a long
request followed by multiple messages: those messages should receive replies in
order without a queue notice. Source tests and image/health checks are separate
from this live Telegram acceptance.

/help, /status, /stop and /cancel are processed at intake without a model call,
even while it is busy. /stop aborts only the requesting user's current main turn;
/cancel <id> aborts that user's queued/running worker. Cancelled turns don't queue
a final model result. Cancelling cannot undo actions already executed.

Ordinary messages are queued, not injected into a running turn. The current SDK
integration has no live steering path; an app-server turn/steer implementation
would be a separate change. No /steer command is advertised.

## Learning upgrades

Learning upgrades add SQLite tables/triggers and one managed AGENTS.md routing
section. Existing owner, Compose identity, data mounts, authentication and custom
profile sections remain. CORE.md stays in the read-only image; PLAYBOOK.md and marked
learning sections are generated in the existing workspace. Preserve a consistent
SQLite backup and instruction snapshot before recreation. See [learning](learning.md).
