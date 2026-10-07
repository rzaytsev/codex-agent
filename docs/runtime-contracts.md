# Context, provenance, skills and runtime contracts

This lane verifies source assembly and host contracts with synthetic data. It makes
zero model calls and cannot establish model quality, live Codex compaction, cache
hit/latency improvements, authenticated startup, deployed health or user acceptance.
Full credential/filesystem/process/native-tool isolation is **INCOMPLETE AND
BLOCKING**. Both isolation prototypes remain disabled by default.

## Context and authority

Codex owns its compaction. The application adds no compactor or unlimited replay:
fresh main threads receive twelve recent history rows; resumed main threads receive
only unseen rows from that tail. Each row carries a host source label. Current
request and conversation/audience/route stay explicit in turn input. Checkpoints are persisted only with terminal results, not periodically mid-run.
Up to eight scoped task checkpoints are projected as model-reported, host_verified=false.
Every validated unresolved-effect slot is retained; descriptions over 240 characters
are truncated with a task_status retrieval pointer. Full originals remain in SQLite.
Workers receive only their matching task checkpoint when one exists. A checkpoint
cannot resume a job, mint owner intent or authorize retrying an uncertain effect.
Older corrections outside the bounded tail require native thread continuity or
explicit memory/history retrieval; synthetic fixtures do not prove live retention.

Host intake extends history_origins with additive known_quote metadata. Telegram
quote, blockquote and expandable_blockquote entities (including caption entities)
label the entire mixed message conservatively. Known quotes, forwarded input and
attachments cannot mint direct approval, new preference/outcome authority or new
confirmed owner facts through the real host gates. Original unquoted owner DM and
linked-owner group facts remain supported; group facts grant no DM preference or
outcome authority. Legacy origins/revisions/audit are retained. Arbitrary pasted
quotation boundaries and semantic entailment are not inferred from text regex.
These gates do not constrain arbitrary code with the process's filesystem grants.

The volatile browser output directory appears in per-turn input and MCP argv.
Static browser developer instructions retain output ownership and source distrust.
Synthetic distinct-output runs require identical developer instructions/prompt hashes
and effective tool hashes. Missing/unattributed cumulative usage stays unknown;
instruction stability does not invent token attribution or measured caching gains.

## Skills inventory and routing expectations

src/shared-skills.js owns the reviewed inventory: learn, scrape, skillify,
investigate, planning, telegram-read, project-manager and google-maps. Tests match
all eight source metadata files, exact read-only Compose mounts and native paths.
The optional laptop agent-messaging directory is excluded; no SSH/mount/installation
or update automation is introduced. Discovery smoke uses this inventory and checks
skills/list metadata. App-server startup can access cloud/model catalog/local state;
metadata discovery is not side-effect-free authenticated startup. Use --anonymous
with disposable HOME/CODEX_HOME for synthetic checks. Real-instance discovery needs
separate operator authorization and runtime compatibility acceptance.

The twenty-four should-trigger, near-miss and quality specs in
[test fixtures](../test/fixtures/skills-contracts.json) define expected selected
skills, denied effects and required evidence. The deterministic harness scores
explicit structured synthetic decisions and negative candidates; it never infers
semantic routing quality from request strings. Real model decisions/helpfulness
need an opt-in model lane with input/expectation separation. Plan-only execution
uses the existing enforced read service scope; wording alone supplies no scope.

## Pinned compatibility and upgrade gate

```sh
node --test test/context-contract.test.js test/runtime-contract.test.js
node --test test/task-outcomes.test.js test/restricted-read.test.js test/observations.test.js
npm run eval:skills
npm run contract:runtime -- --output /tmp/runtime-contract.json
```

The reviewed golden pins SDK/CLI 0.159.2, Playwright MCP 0.0.83, all package
dependencies, declared Node image/uv versions, installed package versions, SDK parser
bytes, response/review schemas, effective registry definitions and prompt templates/
assembly. Tool definitions include schemas, roles, scopes, side-effect categories,
retry, timeouts and DM metadata. Manifests contain only fixed source paths and
hashes; they never serialize SDK configuration, capabilities, credentials or env.
The Node image uses the declared 24-bookworm-slim tag, not an immutable digest;
Debian Chromium/OS package versions are build-dependent and remain a target gate.

Pinned parser fixtures execute owned synthetic binaries beneath the actual SDK
and application supervisor. Differential argv/config/env/schema/input fixtures
cover fresh/resumed execution; selected restricted fixtures verify exact environment,
custom permissions and absence of the legacy sandbox override. TERM-ignoring child
fixtures require actual exit before settlement. These prove synthetic compatibility,
not authenticated CLI/native tools or escaped descendants.

Prerelease/runtime upgrades must pass these contracts and the target Linux image,
browser/native/skill/permission/environment gates before acceptance. Refresh the
golden with `node scripts/runtime-contract.js --write-golden` only after reviewing
the exact source/pins and migration implications; refresh is not acceptance. No
runtime dependency upgrade was made here. Keep authenticated startup/model/Telegram
and live long-session correction/route/checkpoint acceptance separately opt-in.

## Migration and rollback

Back up consistent SQLite plus workspace/artifacts/profiles/Codex home before
an operator image update. Startup adds only history_origins.known_quote, default
zero for retained rows; it does not fabricate old quote boundaries, rewrite active
preferences, remove history, change threads or alter schedule policy. Source rollback
leaves the additive column and audit intact, but older code lacks quote authority
gates and bounded checkpoint input. Stop and reconcile uncertain work before a
downgrade; a full matched pre-upgrade restore loses subsequent writes. Never replay
uncertain effects or downgrade Task 7 requested-cancellation state blindly.
Image core/role changes reach existing instances on authorized image recreation;
seed templates initialize missing files and preserve existing custom profiles.
