# Shared assistant skills

The optional [agent-messaging](../shared-skill/agent-messaging/SKILL.md) skill is
installed separately on laptops and uses scripts over SSH. Container assistants
use their existing tool bridge. See [agent messaging](agent-messaging.md).

The additional [telegram-read](../shared-skill/telegram-read/SKILL.md) skill uses
the image's pinned tdl CLI to read bounded Telegram user content after a separate
interactive owner login. Its mount is read-only; session data remains private and
per-instance. See [setup and verification](telegram-read.md). The discovery smoke
below checks it alongside the other seven owned container skills.

The Compose service mounts nine owned skills read-only into every
instance's `.agents/skills/` directory. Source is in `shared-skill/`; the five gstack-inspired adaptations'
ORIGIN.md files record the pinned upstream revision and included MIT license. These
are adaptations for this assistant, not an installation of the whole gstack suite.

| Skill | Use |
| --- | --- |
| `learn` | Record and recall verified procedures through versioned memory tools; legacy `memory/learnings/` remains readable. |
| `scrape` | Extract website records with source/coverage evidence and validation, then return data artifacts. |
| `skillify` | Convert a successful scrape into an instance-local executable skill after fixture tests and a fresh source check. |
| `investigate` | Trace a failure through evidence and hypotheses; repair only when the task authorizes it. |
| `project-manager` | Carry an authorized project through milestones and observable checks. |
| `google-maps` | Use explicit/saved location and configured provider grants for places/routes. |
| `telegram-read` | Read bounded owner-authorized user-account content; no sends. |
| `deep-research` | Preserve a comprehensive investigation as sources, evidence, review and reports; see [research](research.md). |
| `planning` | Combine office-hours discovery, product scope review, engineering review and relevant user-flow review into one plan. |

Startup appends routing guidance to existing workspace AGENTS.md once, preserving
custom instructions. The same initialization covers newly created instances.
Skills remain eligible for normal automatic selection; they add no Telegram menu
commands. In Telegram, ask naturally or use the Codex skill marker:

```text
$learn What have we learned about my report generator?
$scrape Extract names, prices and URLs from this page: https://example.com/listings
$skillify Save the extraction we just verified as a reusable skill.
$investigate Find why the report generator is failing; diagnose before changing it.
$planning Plan a weekly briefing workflow using my available sources.
```

`planning` is the only combined planning skill name; office-hours and individual
planning-review names are not separately installed. Plan-only requests end with
a plan. Authorized delivery requests can continue through project-manager.

The adaptations use the existing browser MCP, worker/research/review profiles,
uv and Telegram artifact queue. No Bun, Aside, gstack browser daemon, outside
model provider, telemetry or cloud-memory synchronization was added. Generated
skills, fixtures, notes and plans stay in each instance's persistent workspace;
they are not automatically promoted to shared-skill or another agent.

These are model-selected instructions, not a deterministic learning daemon or a
guarantee that every task invokes them. Scrapes do not create recurring monitors
unless requested. Browser login/CAPTCHA limits remain. Python Playwright for a
generated rendered-page script is installed with uv when needed; it is not a new
baseline dependency in the image. Shared skills must not be overwritten by the
runtime agents.

The service's separate [memory consolidation](memory.md) provides quiet daily and
weekly processing of collected evidence. The learn skill is immediate capture
and recall, not another recurring job.

After source sync, prepare shared-skill ACLs, rebuild and recreate each named
instance using the deployment instructions. Validate discovery from each:

```sh
./bin/agent exec demo assistant node scripts/shared-skills-smoke.js
```

The helper uses the pinned Codex app-server `skills/list` metadata endpoint;
it makes no model call and sends no Telegram message. Startup can contact cloud/
model catalog and create local state; authenticated discovery requires separate
operator authorization. Anonymous disposable checks use --anonymous; no real
instance auth belongs in synthetic discovery. It must report all nine
names enabled at their workspace mount paths. Behavior also needs a real task
check; metadata alone proves availability, not correct decisions.

Run the smoke check on each deployed instance. Availability and behavior require
validation on that runtime; personal deployment receipts remain private.

Sources: [gstack](https://github.com/garrytan/gstack),
[official Codex skill discovery](https://learn.chatgpt.com/docs/build-skills),
[official app-server skills metadata](https://learn.chatgpt.com/docs/app-server#skills).

The source inventory, mount/path checks and should-trigger/near-miss/quality fixture
scorer are described in [runtime contracts](runtime-contracts.md). No skill install
or update automation is added; metadata/scorer checks do not prove model routing.
