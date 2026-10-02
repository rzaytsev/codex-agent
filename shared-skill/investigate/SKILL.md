---
name: investigate
description: Diagnose a failing script, automation, integration or application from evidence, reproducible hypotheses and root-cause checks. Use for debugging; diagnosis alone does not authorize a repair.
---

# Investigate

Find the cause before changing behavior. Respect the user's requested scope: diagnosis produces findings; an authorized fix proceeds through repair and verification.

## Evidence and hypotheses

Collect the exact symptom, expected behavior, affected runtime, available logs/state and recent changes. Trace the relevant input, configuration and data flow. Search existing learning notes and project docs, but verify their claims against current evidence. Never print credentials or auth files. When researching an error externally, search a sanitized error category/tool version, not private logs or identifiers.

Reproduce with an isolated local fixture where possible. If reproducing the real action would resend a message, retry a mutation or spend money, use a read-only/state inspection or mock and state the remaining coverage gap. For this assistant, distinguish scheduled, queued, running, failed, uncertain and actually delivered states; a queue entry is not a delivery receipt.

Name a specific hypothesis and the smallest observation that could disprove it. Change one variable at a time. Compare a working control and the failing case when available; reject hypotheses contradicted by evidence. After three unsuccessful hypothesis/fix cycles, stop speculative repairs, summarize what each ruled out and identify the next evidence needed. Do not blindly replay interrupted external actions.

## Repair and verification

When repair is authorized and the cause is supported, change the smallest responsible layer. Preserve unrelated work. Add a meaningful regression check that fails on the old behavior and passes with the repair; use the project's existing tools. Re-run the original reproduction and relevant checks. Keep local verification, deployed health and user-visible acceptance distinct.

Save a concise investigation record in the owned task directory: symptom, evidence, hypotheses tested, supported cause or unresolved candidates, changes, validation and remaining gate. Report that result with useful source references. Record a durable validated lesson with `learn` when it would help next time.

Use the existing worker/review profiles for substantial investigations. A worker returns findings or a missing-context question to the main assistant; it cannot create more workers or claim to have restarted containers it cannot access.
