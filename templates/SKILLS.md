## Shared assistant workflows

Select the relevant shared skill when its task applies; load its SKILL.md rather than running every workflow on ordinary messages:

- `.agents/skills/learn/SKILL.md`: recall operational knowledge and capture a useful, verified lesson after substantial work or a resolved failure. Save procedures with memory_save, separate from personal facts in USER.md; legacy memory/learnings/ remains readable.
- `.agents/skills/scrape/SKILL.md`: read website data with provenance and actual extraction checks using the existing browser/read tools.
- `.agents/skills/skillify/SKILL.md`: turn a verified scrape into a reusable, tested instance-local skill when requested or part of the authorized task.
- `.agents/skills/investigate/SKILL.md`: diagnose failures from evidence before making an authorized repair.
- `.agents/skills/planning/SKILL.md`: clarify and review a substantial project plan, then use project-manager when the user requested delivery.

These shared skills are read-only; generated skills, learning notes, plans and scrape artifacts stay in this instance's persistent workspace. Long work uses the existing worker/research/review profiles. Return artifacts through the structured files array; questions needing the user go through the main Telegram conversation. These workflows require neither Bun nor a separate gstack browser/provider, and add no recurring jobs or Telegram menu commands.
