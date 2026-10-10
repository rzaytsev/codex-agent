# Regular and deep research

The assistant selects research depth from the request. Regular research answers a
focused question with a few checked sources; longer regular source-reading tasks
use the existing read-only `research` profile. Deep research covers several
subquestions, compares evidence and produces a saved, cited report through the
`deep_research` profile. Explicit deep research, literature reviews and comprehensive
comparisons normally select deep. If depth is ambiguous and changes scope, time
or subscription use materially, the assistant asks whether the owner wants a
focused answer or a deep report. A plan-only request still ends with a plan.

This selection is model behavior guided by image-owned instructions, workspace
AGENTS.md and the [deep-research skill](../shared-skill/deep-research/SKILL.md).
It is not a keyword router or a guarantee of exhaustive coverage.

## Telegram workflow

Ask naturally, for example: “Deep research retrieval strategies for our support
assistant. Compare original papers, explain contradictions and send a report.”
The main turn admits one background task and returns promptly. The existing
worker-start acknowledgment, `/status` and `/cancel <task-id>` remain the interface.
Status includes saved source/claim counts and draft/review stage. Completion goes
directly to the original private chat, topic or linked group, with a concise
summary, a few visible source URLs and PDF plus Markdown documents. Groups can
see their delivered artifacts; another chat is not an automatic fallback route.

The worker saves a scope, subquestions and inclusion criteria, records actual
search queries and candidate selection, reads original sources, saves claims with
supporting or contradicting passages, and drafts a synthesis with limitations.
The service then runs a separate read-only model turn to review every referenced
claim at its exact revision. Unsupported claims are omitted; uncertain findings
remain qualified. Analysis is labeled as model interpretation and is omitted
when its section contains a rejected claim. The service exports reports and
queues immutable file snapshots through the existing outbox.

Queued output, confirmed Telegram sending and owner acceptance are separate
states. A failed review/export fails the job without claiming a completed report;
collected evidence remains available. Cancellation and restart retain evidence
but do not automatically resume execution. A requested continuation starts a new
task with the prior dossier ID as context and preserves earlier versions.

## Collection, storage and recall

SQLite is authoritative. Additive `research_dossiers`, `research_searches`,
`research_sources`, `research_claims`, `research_reports` and `research_fts` tables
live in the canonical owner database. Dossiers bind owner, conversation, original
session and job. Claims retain revisions; plans use revision checks. Research
does not insert the full corpus into personal-fact memory.

| Tool | Purpose and authority |
| --- | --- |
| `research_search`, `research_read` | Scoped retrieval; current conversation by default, explicit `scope=all` for relevant owner chats. Source text is paginated. |
| `research_plan` | Save/update the assigned task's scope, questions and criteria. |
| `research_query` | Record searches actually performed and included/excluded/unread candidates. |
| `research_fetch` | Fetch and retain extracted text from a public source; return a source ID. |
| `research_claim` | Save a versioned claim with exact retained passages and locators. |
| `research_finish` | Save a draft for service-owned review and export after the worker turn. |

Write tools require an active deep worker, matching owner, conversation, session
and task. Deep scope denies task spawning, schedules, profile/memory mutations and
brokered external sends. Regular `research` remains read-only. Internal reviewers
receive a fresh read-only turn without editable profiles, browser or web search.
The research sandbox allows task workspace writes. Native runtime permissions,
inherited MCP configuration and filesystem access remain separate from service
tool permissions; this feature does not establish credential or task isolation.
See [action policy](action-policy.md) and the [official MCP configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Public collection supports HTML, text and text-bearing PDFs. It pins validated
public DNS addresses, revalidates redirects, excludes credentials/cookies and
rejects private addresses. Responses are bounded to 8 MiB and extracted text to
250,000 characters. The stored SHA-256 identifies fetched response bytes; original
response bytes are temporary and removed after extraction. Page titles can come
from the page; author/date/DOI and full-text versus abstract labels are model
metadata. Inaccessible, oversized, unsupported or textless documents are recorded
as unavailable. Scanned PDFs, paywalls, login and CAPTCHA barriers are disclosed;
browser discovery does not make an unavailable document verified evidence.

The service matches normalized quotes to retained text. This proves that a passage
exists in the snapshot, not that its interpretation is correct. Independent model
review assesses the supplied passages and draft, not an independent full-corpus
search. It cannot establish truth, exhaustiveness or research quality by itself.

Exports live under `tasks/<dossier-id>/report-<revision>/`: `report.pdf`,
`report.md`, `sources.csv` and `evidence.json`. The evidence export includes claim
revisions used, review decisions, source metadata and the complete search log;
full source text remains in SQLite. PDF and Markdown are delivered by default;
the other files can be requested later. Retain the SQLite database, task files and
outbox artifacts together through cleanup, recreation and backup. Research
remains private owner data; do not publish live reports as shared-skill fixtures.

## Configuration and operations

`DEEP_RESEARCH_MODEL` defaults to the authenticated runtime model;
`DEEP_RESEARCH_REASONING` defaults to `high`. `RESEARCH_MAX_SOURCES` defaults to
40 (1–200); each dossier also caps 200 distinct search records and 100 claim keys.
Existing worker concurrency, timeout and logical-run budgets apply to collection,
review and export. Review uses the review model/reasoning settings. No API billing
or alternate model-provider fallback is introduced.

Pandoc, LibreOffice and Poppler already in the image produce and check PDFs.
Reports preserve request language; document layout needs visual inspection during
rollout. `templates/RESEARCH.md` appends a uniquely headed section to existing
workspace AGENTS.md once, preserving custom content; rebuilding/recreating
instances distributes image instructions and mounts the ninth shared skill.
Changing contributor AGENTS.md alone does not update live bots.

Run `test/research.test.js` and `test/prompts.test.js`, then the normal
[development checks](development.md). `scripts/research-smoke.js` uses the real
subscription-backed runtime, a disposable synthetic workspace and intercepted
delivery; it never polls or sends Telegram. It checks natural admission, public
source retention, exact evidence, separate review and real PDF export. Model calls
consume subscription quota. Keep smoke receipts private. A deployed synthetic
probe through the existing bot loop proves delivery separately from owner quality
acceptance.

Back up matched SQLite/workspace/profile/auth state before rollout. The migration
is additive; recreate existing Compose projects and persistent mounts. For
rollback, stop and reconcile active jobs/outbox, select the previous image and
retain research tables/files for forward recovery. The old runtime cannot run
queued deep tasks; cancel/reconcile them before downgrading. Restoring a prior
snapshot loses subsequent state and must use matched files/database. See
[deployment](deployment.md) and [backups](backups.md).

## Research basis

These papers informed the workflow, rather than supplying a proven implementation
or performance guarantee for this bot:

- [STORM, NAACL 2024](https://aclanthology.org/2024.naacl-long.347/): organize questions and perspectives before writing a grounded long-form answer.
- [MindSearch](https://arxiv.org/abs/2407.20183): break a broad search into linked subquestions; this implementation uses one bounded worker rather than a worker swarm.
- [WebThinker](https://arxiv.org/abs/2504.21776): alternate search, navigation and synthesis while filling evidence gaps.
- [OpenScholar](https://arxiv.org/abs/2411.14199): retrieve scientific evidence and improve answers through citation-aware feedback.
- [PaperQA2](https://arxiv.org/abs/2409.13740): preserve passages and citation provenance for scientific literature synthesis.
- [ALCE, EMNLP 2023](https://aclanthology.org/2023.emnlp-main.398/): evaluate citation support and completeness separately from fluent writing.
- [DeepResearchBench](https://arxiv.org/abs/2506.11763) and [ReportBench](https://arxiv.org/abs/2508.15804): treat report quality, evidence and coverage as evaluation questions, not completion counters.

Several are preprints. Local contracts and smoke tests prove the stated mechanics,
not benchmark scores or owner acceptance of substantive research.

Deep workers receive the selected workflow text in their assembled instructions,
so native sandbox file access is not required to read the skill. The pinned Codex
configuration explicitly approves only the effective research service tool names;
the service still rechecks role, task and route on every operation. This fixes
write-tool approval rejection under workspace-write plus approval_policy=never.
