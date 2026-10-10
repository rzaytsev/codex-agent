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
npm run eval:contracts
npm run eval:skills
npm run contract:runtime -- --output /tmp/runtime-contract.json
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

For instruction changes, read [prompt contracts](prompts.md) and run
`test/prompts.test.js` alongside the affected service suites. Inspect assembled
SDK instructions for main, worker, read-only and internal review roles. Synthetic
assembly checks cannot establish model adherence or deployed behavior.

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

## Scheduler verification

For scheduler changes run `node --test test/scheduler.test.js test/admission.test.js
test/reliability.test.js test/learning.test.js test/memory.test.js test/tooling.test.js
test/conversations.test.js test/conversation-migration.test.js test/assistant.test.js
test/integration.test.js test/prompts.test.js`, then the standard full checks.
Fixtures cover slow workers, unique occurrences, abrupt process exit and snapshots,
prior-shape version1 receipts, bounded outage/DST, deadline admission and exact
owner receipt rollback. No live endpoint/model/Telegram test is implied.

## Toolchain boundaries

Codex SDK/CLI and Playwright MCP are pinned in package.json. requirements-tools.txt
pins document/data libraries; Dockerfile declares OS tools and uv. Actual installed
versions and account features must be verified on the selected image. Normal
worker code installs extra Python dependencies in workspace/project venvs, not the
read-only image. Python upgrades can invalidate old venvs: startup fails visibly
rather than deleting user-installed packages. See [configuration](configuration.md)
and [deployment](deployment.md) before changing runtime paths or versions.

## Held-out memory and learning checks

Use [memory quality evaluations](memory-quality-evals.md) for the synthetic
multi-turn suite, per-case scoring and paired memory-on/off observations.
Deterministic harness tests run with npm test; subscription inference requires
explicit opt-in in a disposable runtime. Existing smoke helpers remain separate.

## Observations verification

Run `node --test test/observations.test.js test/agent-lifecycle.test.js test/integration.test.js test/artifacts.test.js test/reliability.test.js`, then the normal check, full Node suite, Python tests and publication check. Fixtures invoke the actual pinned SDK parser against disposable synthetic subprocesses, never model/account endpoints. Verify local CLI version with `node node_modules/@openai/codex/bin/codex.js --version`; this does not request a model. Test raw SDK/error canaries only against observation rows/logs: authoritative user history legitimately contains source content. See [observations](observations.md).

## Action-policy verification

Run test/action-policy.test.js, test/profile.test.js, test/prompts.test.js,
test/admission.test.js, then the real synthetic MCP/mailbox tests and normal full
checks. The policy suite exercises exact consent, payload/authority drift, ledger
faults, abrupt process exit, restart replay and uncertain no-send recovery.
`node scripts/isolation-probe.js` uses only disposable canaries and no real auth,
models or network requests. Nested sandbox unavailability is an honest gate; an
approved disposable execution outside that wrapper can measure the installed
sandbox. The built-in read-only macOS profile blocks writes and allows canary
credential/foreign-task reads; `--mode=restricted` selects the separate exact-root
probe and tests its owned positive/denial controls. Run `node --test
test/restricted-read.test.js test/prompts.test.js` for fresh-thread/cursor, actual-SDK
argv, cleanup and fixed reviewed hash regressions. Also run
`node --test test/restricted-config.test.js` for actual pinned anonymous config
layering (extra shell set, foreign MCP and inherited assistant env/defaults),
rejection before SDK construction, no-helper markers and bounded RPC failure
cleanup. These tests use fresh anonymous HOME/CODEX_HOME and no thread/account/model
RPC. App-server startup still creates local state and can contact cloud/model
services with authentication; anonymous tests do not establish that compatibility.
Outside-wrapper restricted
macOS fixture protection does not complete Linux/auth/native/tool acceptance. See [action policy](action-policy.md).

The approval regression drives persisted multi-chunk envelopes through real
Service.deliver and Telegram.sendPart with a fake fetcher. Verify literal
backticks/asterisks/<>&/quotes/emoji, full canonical hash/commit identity, ordinary
reply formatting, model flag refusal and pre-fix approval-version rejection.


## Production contract and outcome verification

Run `node --test test/learning-outcomes.test.js test/production-contract.test.js test/learning.test.js test/memory-quality.test.js`, then the standard full checks.
`npm run eval:contracts -- --output /tmp/production-contract.json` produces a
synthetic publication-reviewable manifest without credentials/models/sockets.
Meaningful BAD final-state/forbidden-action observations must fail; adapter errors
must remain unscored. Do not infer model usefulness or live rollout from contracts.
Receipt migration is additive; preserve SQLite/workspace backups and retain outcome
receipts when retiring a rule. New learning authority needs host-attributed direct
owner input; adapt synthetic fixtures through host intake instead of merely marking
history as user. See [learning migration/rollback](learning.md#host-outcome-receipts-and-authority).

When extending production contract fixtures, mint expected denial codes at the
application validation point rather than inferring them from error text in the
adapter. Add the operation-specific adapter mapping and held-out code check. Inject
unexpected service and learning exceptions against the actual adapter to verify
null metrics and suppressed raw errors; a mock adapter exception alone misses
inner catch-all bugs. Codes are in-memory validation metadata, with no DB migration
or HTTP error-envelope change.


## Task outcome verification

Run `node --test test/task-outcomes.test.js test/reliability.test.js test/agent-lifecycle.test.js test/media.test.js test/voice.test.js test/scheduler.test.js test/observations.test.js test/restricted-read.test.js test/prompts.test.js`, then normal check/full Node/Python/publication checks. Actual pinned SDK fixtures use owned executable children with ignored SIGTERM and argv/env comparisons, never a model/account endpoint. See [boundary and acceptance limits](task-outcomes.md).

## Context and runtime compatibility verification

Run test/context-contract.test.js and test/runtime-contract.test.js first, then
the pinned supervisor/parser/restricted tests and full checks. Review golden refresh
bytes explicitly; all prerelease upgrades require contracts plus target-image
acceptance. Anonymous disposable skills discovery uses --anonymous; authenticated
startup can contact cloud/model state and needs separate authorization. Synthetic
routing checks prove the scorer/expectation format, not semantic selection quality.
See [runtime contracts](runtime-contracts.md) for commands, migration and gates.

## Research verification

Run `node --test test/research.test.js test/prompts.test.js` first, then full checks.
Refresh runtime goldens only after reviewing effective scope/schema/inventory
changes. `node scripts/research-smoke.js --output /tmp/research-smoke` is an opt-in
subscription-backed check in a disposable workspace with intercepted Telegram
delivery and no poller. Inspect its real rendered PDF as well as receipt counts.
Verify deployed delivery separately; none of these establish owner quality
acceptance. See [research](research.md).
