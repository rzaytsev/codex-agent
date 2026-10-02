---
name: planning
description: Clarify a substantial project, challenge its scope and compare approaches, then review product, engineering and relevant user flows to produce an actionable plan. Use for project planning, not routine status or small tasks.
---

# Planning

Combine office-hours discovery with product and engineering plan review. Scale the work to the project; ordinary questions and small edits do not need a planning ceremony.

## Understand the problem

Read the relevant project entrypoint, existing decisions, learning notes and available source/code evidence. Identify who needs what, a concrete current pain, the desired outcome, constraints and an observable acceptance example. Separate confirmed requirements, assumptions and unknowns. A requested implementation is a proposed solution; check whether it addresses the actual problem without substituting a different goal.

Challenge material premises: what happens if nothing changes, what already solves part of this, and what evidence supports the demand or benefit? Ask only questions whose answers change the outcome, scope or risk. In Telegram use a concise normal reply when clarification is necessary. Workers return unresolved questions to the main assistant. Do not invent an AskUserQuestion tool or pause for routine preferences; use stated reversible assumptions.

## Compare and review

When the approach is genuinely unsettled, compare the requested/current approach with a smaller viable option and any justified larger alternative. Explain reuse, effort, tradeoffs and failure modes. Preserve existing choices and authorization; do not reopen settled decisions merely to fill a comparison table. Default to holding the requested scope, with possible expansions clearly labeled as proposals.

Review the selected plan through the relevant lenses:

- **Product:** direct user benefit, minimum useful result, unnecessary scope, success signals and how the user will receive/use the result.
- **Engineering:** actual dependencies/tools, interfaces and data flow, persistent state, concurrency, errors, recovery, permissions and meaningful tests. Inspect the relevant code/configuration for a technical plan; distinguish verified capabilities from proposals.
- **User experience, when applicable:** the main flow, missing/empty/loading/error states, accessibility, information hierarchy and concrete outputs. Developer-facing projects also need usable setup and diagnostics. Skip UI design scoring for projects with no UI.

Resolve contradictions between these lenses. Use the existing research/review worker profiles when a substantial technical review benefits from them; do not demand another model/provider or claim an independent review that did not run.

## Deliver and continue

Save the plan in the user's selected project/docs location, otherwise in the owned task directory or `projects/<project>/plan.md`. Include the goal and acceptance example, agreed scope, evidence/assumptions, chosen approach and tradeoffs, dependencies, milestones with checks, risks/recovery and open decisions. Include the plan path in `files` when it is a deliverable.

For a plan-only request, finish with the plan and decisions needing an answer. When the user requested delivery and the necessary work is already authorized, continue through the existing project-manager workflow; do not ask again for an approved step. Planning itself grants no additional authority to deploy, send, purchase or mutate connected accounts. Record important explicit project decisions through `learn` without inventing personal facts.
