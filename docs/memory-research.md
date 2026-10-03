# Research behind assistant memory

Reviewed 2026-10-02. Nightly consolidation is a useful engineering
analogy to sleep: collect events, derive stable knowledge, reconcile it, and
retrieve relevant evidence later. This implementation does not model human sleep
or claim that a daily schedule is biologically optimal.

## Papers and what transfers

| Paper | Useful result/design idea | Our choice and its limits |
| --- | --- | --- |
| [Generative Agents](https://arxiv.org/html/2304.03442v2), Park et al., UIST 2023 | A memory stream, retrieval combining relevance/recency/importance, and reflection support agents over time. The authors also report fabricated embellishments and retrieval failures. | Preserve source history, derive episodic notes and durable records, and consolidate quietly. Their evaluation concerns simulated social behavior; it does not establish personal-assistant factual accuracy or our scheduling policy. |
| [MemGPT](https://arxiv.org/html/2310.08560v2), Packer et al., 2023/2024 preprint | Distinguish small working context from external recall/archive storage, and use explicit functions to move evidence into context. | Keep USER.md compact, retrieve bounded relevant records, and expose memory/history lookup tools. We do not reproduce MemGPT's full control flow or eviction algorithm. |
| [LongMemEval](https://arxiv.org/html/2410.10813v2), Wu et al., ICLR 2025 | Test extraction, multi-session reasoning, time, knowledge updates and abstention. Indexing, retrieval and reading are distinct failure points; session decomposition and time-aware retrieval matter. | Small sourced records, dates/revisions, chronological pagination, correction/unknown-answer checks, and separate retrieval limits. Our regression/smoke checks are inspired by these abilities; they are not a LongMemEval benchmark result. |
| [Mem0](https://arxiv.org/html/2504.19413v1), Chhikara et al., 2025 preprint | Incremental extraction followed by comparing candidates with existing memory and applying add/update/delete/no-op decisions. | Search before adding; stable keys and revision checks protect updates; no-op is valid. Archive with evidence rather than automatically delete old facts. We do not adopt its vector/graph services or claim its published performance for this system. |

These have widely used public implementations/evaluation resources. A public
GitHub API snapshot on this date reported 22,177 stars for
[Generative Agents](https://github.com/joonspk-research/generative_agents), 24,996
for [Letta](https://github.com/letta-ai/letta), the platform that grew from MemGPT,
1,125 for [LongMemEval](https://github.com/xiaowu0162/LongMemEval), and 66,435 for
[Mem0](https://github.com/mem0ai/mem0). Stars are a software-adoption signal, not
paper citations, peer review or evidence that one architecture is more accurate.
Counts came from each corresponding `https://api.github.com/repos/OWNER/REPO`
endpoint; they are dated, not live counters.

## Decision

A collection of Markdown files without retrieval, update rules and provenance
still becomes a confusing archive. A huge always-loaded file increases irrelevant
context and does not resolve contradictory facts. A graph/vector platform would
add providers, credentials, persistence and tuning before this assistant has a
measured need for them.

Start with the existing SQLite service: canonical versioned records, FTS5 keyword
search, readable Markdown projections, immediate useful capture and daily/weekly
consolidation. Add semantic retrieval only after repeated paraphrase/language
misses are demonstrated with a representative fixture set. Do not substitute
API-billed embeddings for ChatGPT subscription authentication silently. A local
embedding model is a possible later option, with its own resource/evaluation cost.

New memory comes from original statements and validated source work. Repeated
summaries are not independent confirmation. An uncertain claim should stay
uncertain; absent evidence should produce an honest unknown. Changing live state
(task completion, appointments, usage limits, location) must be rechecked in its
own authoritative tool rather than taken from a historical note.

See [memory implementation](memory.md) for the actual layout and schedule.

## Continuous learning research (2026-10-03)

- [Reflexion](https://arxiv.org/abs/2303.11366): retain textual lessons derived from
  task feedback for subsequent attempts; no model weight update is required.
- [Agentic Context Engineering](https://arxiv.org/abs/2510.04618): separate execution,
  reflection and curation; incremental context updates reduce loss from full rewrites.
- [GEPA](https://arxiv.org/abs/2507.19457): propose and evaluate prompt changes from
  execution feedback. We borrow evidence-based iteration, not its evolutionary optimizer.
- [Ask Now, Use Later](https://arxiv.org/abs/2605.28108): acquire reusable preferences
  before later tasks need them, while recognizing the interaction cost of questions.
- [Intrinsic self-correction limits](https://arxiv.org/abs/2310.01798): the tested
  reasoning settings showed that self-critique without external feedback can degrade
  results. Independent validation is a gate, not a substitute for observed outcomes.

These motivate [learning](learning.md); their benchmark results are not a claim of
measured benefit for this personal assistant. Trials need later outcome evidence.
