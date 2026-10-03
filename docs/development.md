# Development and validation

Start with root AGENTS.md and the [feature inventory](features.md). Node.js 24+
is required (node:sqlite is used); dependencies are pinned in package-lock.json.
Python 3 runs host-helper tests. Docker Compose validates deployment configuration;
a running Docker daemon is needed only for building/running containers.

## Local workflow

```sh
npm ci
npm run check
npm test
python3 -m unittest discover -s test -p '*.py'
python3 scripts/check-publication.py
```

Start with the test file for the changed subsystem. MCP tests bind localhost;
if a sandbox denies socket access, rerun that specific suite with appropriate
local permission rather than claiming a source failure. The npm test command explicitly selects test/*.test.js so ignored private
archives or projects are never discovered as test suites. Tests use temporary
synthetic workspaces and no real Telegram/model credentials. Instance tests copy
a minimal fixture repository and resolve two Compose projects without a daemon.

Do not run npm start in an existing personal workspace to test changes. A second
process can consume the same Telegram updates or recover shared database jobs.
Use temporary WORKSPACE_DIR and CODEX_HOME, empty Telegram settings and disabled
proactivity for an unconfigured local service test.

## Runtime validation ladder

For shared owner conversations, run `test/conversations.test.js` and
`test/conversation-migration.test.js` first. Verify shared recall/rules/tools,
separate recent context, migration and source routing. `scripts/conversations-smoke.js`
uses synthetic chats/workspace with an existing login and no Telegram polling or
sending; its model calls consume subscription quota. Also verify actual deployed
mentions, delivery, disconnect/reconnect and restart before full user acceptance.

1. Unit/integration suites: authorization, jobs, memory, delivery, files, usage,
   seed behavior, instance selection, backup helpers and publication boundaries.
2. Build the image on the target Docker host and run suites against synthetic
   data. Inspect only safe build/health metadata; no secrets in build context.
3. Optional smoke helpers inside the selected container: browser-smoke.js uses
   Chromium, shared-skills-smoke.js checks native discovery, tooling-smoke.py
   generates/converts artifacts, and google-status.js checks connector metadata.
4. memory-smoke.js makes real model calls with a synthetic isolated workspace.
   Check its prerequisites and quota implications; do not confuse it with a unit
   test. Review runtime/plugin versions before trusting any smoke result.
5. Deploy one instance at a time, compare mount/owner settings, wait for ready
   health and check preserved state. Run an authorized user-visible interaction
   and a backup/restore drill before claiming full acceptance.

Use bin/agent for selected-instance operations. Its config command is quiet;
plain docker compose config can print resolved credentials. Never paste raw
inspect env, auth files, histories or database rows into reports.

## Change checklist

Keep code, tests, feature status, decisions and linked operational docs consistent.
When a proposal becomes implemented, replace the stale proposal or mark it
superseded. Keep deployment receipts private. Preserve unrelated workspace changes,
legacy data and custom instruction sections. Before publication inspect candidate
filenames/content, staged bytes, commit identity and any imported history.

## Toolchain boundaries

Codex SDK/CLI and Playwright MCP are pinned in package.json. requirements-tools.txt
pins document/data libraries; Dockerfile declares OS tools and uv. Actual installed
versions and account features must be verified on the selected image. Normal
worker code installs extra Python dependencies in workspace/project venvs, not the
read-only image. Python upgrades can invalidate old venvs: startup fails visibly
rather than deleting user-installed packages. See [configuration](configuration.md)
and [deployment](deployment.md) before changing runtime paths or versions.
