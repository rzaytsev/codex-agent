# Memory and learning quality evaluations

This small synthetic suite complements, and does not replace, the storage tests
and real-model smoke helpers. The learning smoke deliberately specifies a proposal
key, kind, scope and status. That verifies plumbing; it does not measure whether
the model independently identifies a useful adaptation.

## What is held out

`evals/memory-quality/scenarios.json` contains conversation turns and later tasks.
`expectations.json` contains scorer-only checks. The runner allowlists scenario
fields before calling the adapter. Expected answers, source requirements, regular
expressions and metric names never enter a model prompt or output schema. The
adapter uses unchanged application proposal/validation templates and schemas; it
does not tell the model which key, kind, scope or status to produce.

The nine cases cover:

- One-off formatting versus an explicit persistent comparison preference
- A corrected newsletter value with original-source provenance
- An unsupported assistant claim about a city and time commitment
- A forwarded instruction that must not become owner authority
- Two people sharing a name across different projects
- Unknown personal information requiring abstention
- Durable owner recall across chats, with separate recent-chat context
- A planning lesson applied to another task, then explicitly rolled back

Scorer expectations and later query tasks are held out of extraction/review
prompts. This is not a secret benchmark or a statistically representative user
population. They are public, English, short,
and deliberately inspectable. Do not tune prompts repeatedly against this suite
and then describe its score as unseen generalization.

## Free deterministic checks

```sh
node --test test/memory-quality.test.js
node scripts/memory-quality.js --list
```

The test suite injects a fake SDK to exercise real service consolidation,
validation, SQLite storage, context injection, rollback, cleanup and scoring.
It also checks intentionally wrong answers/sources, missing probes, baseline
pairing, scorer separation, safe errors, unexpected tool events and call limits.
It makes no model calls. Fake reports have `qualityEvidence: false`; a passing
unit test is evidence about the harness, never model recall or learning quality.
The ordinary `npm test` includes these tests. Neither it nor `--list` needs login.

## Optional subscription run

Use a **disposable, isolated runtime**, never a live bot container or a machine
with personal project/account mounts. Provide only the installed source/runtime
and an existing ChatGPT subscription login. Review the pinned CLI/SDK and enabled
tools before execution. No API key or alternate provider is supported.

```sh
node scripts/memory-quality.js \
  --run-model --allow-subscription-usage --isolated-runtime \
  --codex-home /run/eval-auth --model YOUR_SUBSCRIPTION_MODEL \
  --case newsletter-correction --max-calls 8 \
  --output /tmp/memory-quality-run.json
```

`--codex-home` identifies an existing directory containing `auth.json`. The runner
links that file into a new temporary CODEX_HOME; it never prints or copies its
contents into prompts/reports. Authentication refresh may update the original
login. No config, prior sessions, personal skills, or plugins are imported from
that home. The model subprocess receives a small environment allowlist, without
API keys or Telegram/mailbox credentials. Each case/mode gets its own temporary
HOME, synthetic workspace and SQLite database, removed in `finally`.

Omit `--case` for all cases. Both memory-on and memory-off run by default.
`--repeats 3` repeats both arms independently; it consumes more quota. The global
model-call cap is 100 by default, with a 180-second timeout per case/mode. Calls
include extraction, independent learning validation, and answer probes. Choose
an explicit model to make the result attributable. The same model and reasoning
effort (default `low`, adjustable with `--effort`) apply to both arms and reviews.
A full run can consume dozens of subscription calls; inspect one case first.

All three opt-in flags are mandatory. `--isolated-runtime` is an operator
attestation, not a container launcher. The runner starts no Telegram poller,
listener, delivery loop, schedule loop or browser. It removes MCP configuration,
disables apps/plugins/hooks, shell, browser/computer, image, native memory and
multi-agent features, and uses fresh read-only threads with web search and
sandbox network access disabled. These feature switches were checked with the
pinned CLI's `features list`; removed switches are not treated as protection.
The live adapter refuses CLI/SDK versions other than 0.159.2 until reviewed.

This is **not a universal tool firewall**. Read-only mode alone does not prevent
reading files outside the workspace. Unexpected tool events fail the evaluation,
but event rejection detects activity after the runtime has begun it; it is not
pre-execution authorization. Do not place private files in that runtime. Only
synthetic evidence belongs in these fixtures. A future runtime change requires
rechecking tool exposure and isolation before a model run.

## Reading a report

The JSON includes the model/effort, installed CLI/SDK versions, Node version,
hashes of every source module and Markdown template, scenario and expectation
hashes, timestamp, duration, call count and token usage. Each attempted turn also
records hashes of its assembled synthetic AGENTS.md/SOUL.md/USER.md, exact
developer instructions, model input and output schema. These fingerprints do not
put scorer expectations into model input. Each case/mode/repeat has its own
status, probe answers, record snapshots, source IDs and per-check result. `sources` maps real
history references to fixture message IDs; `sourceRefs` retains the synthetic
SQLite references. Generated memory keys are reported, not dictated or scored.
Errors are separate from failed quality checks: their checks have passed=null
and are counted as unscored, not failed. Comparison denominators come from the
expected checks even if either arm errors. Each case and comparison arm reports
passed/failed/unscored counts. Private runtime error text is suppressed. Adapter
errors preserve completed synthetic probe observations, attempted-call counts and
reported completed-turn token usage; usageIncomplete=true marks that failed-call
usage may be missing. Partial observations are not scored as a successful run.
Review unexpected errors locally before sharing diagnostics.

- `comparisons[].answers` compares answer checks between the two arms.
- `comparisons[].records` compares capture, provenance and rollback checks.
- The combined `delta` counts all checks. It is **not** a quality-effect estimate:
  memory-off is expected to lack captured records. Prefer the answer comparison,
  and inspect each safety/abstention check rather than a single aggregate number.
- `qualityEvidence: true` means a real-model adapter was used, not that the model
  passed, improved, or satisfied user acceptance. Runtime errors remain errors.
- A nonzero exit status indicates a memory-on failure or any runtime error.
  Expected baseline quality misses do not alone fail the process.

The off arm skips consolidation/learning and starts with an empty durable store.
Fresh probes suppress recent-history injection and always use a new SDK thread,
so recall cannot pass by reusing the training conversation. The cross-chat
isolation probe retains the application's normal conversation-scoped recent
history path. Both arms use the same prompts, profiles, model and effort. This
is a no-durable-context ablation, not a comparison against a tuned long-context
or history-search baseline: tools are deliberately unavailable here.

Checks are deterministic lexical proxies, not an LLM judge. They can reject a
correct paraphrase or miss a semantically wrong statement containing the expected
words. Inspect answers and sources before interpreting a pass/fail. No aggregate
threshold, significance test or production quality claim is established. The
rollback stage invokes the service feedback API using explicit synthetic owner
evidence; it tests retired state and later context, not autonomous selection of
the rollback tool. The correction case consolidates the original and correction
in one batch; it does not establish correction quality across persisted batches.
It does not test active-promotion usefulness, long histories,
multilingual recall, forgotten-data recovery, restart reliability, or live
Telegram/account behavior. Existing unit tests and smoke checks remain necessary.

## Extending the suite

Add natural source turns and a genuinely later task, then put expectations only
in the scorer file. Match semantics as narrowly as practical without forcing a
storage key. Positive record checks should cite original fixture message IDs;
negative checks should fail if a probe is absent, rather than pass vacuously.
Use separate cases for distinct failure modes. Add intentionally bad observations
to the deterministic scorer tests before depending on a new check. Keep all
fixtures fictitious, and run the publication check before sharing any report.
