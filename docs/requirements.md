# Requirements

Product requirements. These requirements describe the future assistant; they are not claims about implemented behavior.

## Confirmed scope

1. Telegram is the user interface.
2. Run continuously on a selected Linux host inside Docker, managed by Docker Compose.
3. Bind-mount the assistant workspace to a host directory so host-side backups can capture it.
4. Use Codex as the agent runtime. ChatGPT subscription authentication is the intended initial authentication path.
5. Keep an independent main conversation for the owner DM and each explicitly
   linked topic-specific group. Default to low reasoning for ordinary interaction.
6. Delegate substantive tasks to workers with suitable models and reasoning levels; support configurable routing.
7. Allow the user to configure character, tone, reactions, and behavior in workspace/SOUL.md.
8. Maintain workspace/USER.md with the user's name, age or birth date, preferences, and relevant personal context.
9. When USER.md is empty, proactively ask questions to establish the profile. Continuously update it from conversations.
10. Give the assistant full autonomy to perform requested work, create and execute code, create/update local directories and files, improve its workspace, and create reusable skills.
11. Support scheduled tasks and notifications.
12. Accept Telegram text and voice messages, PDFs, images, other files, captions, and forwarded messages. Save originals for later work.
13. Send formatted Telegram messages, generated deliverables, and voice messages when requested.
14. Be proactive: suggest solutions, offer help, identify improvements, and provide grounded motivation.
15. Review previous activity over daily, weekly, and monthly periods.
16. Reflection may use all available connected, authorized sources, including conversations, calendars, task lists, notes, and other work sessions.

## Interpretation and boundaries to finalize

- Full autonomy means no routine confirmations for work within granted resources. Whether self-initiated external actions have standing authority still needs a concrete policy.
- One conversation means a continuous user experience; durable memory and task state must not depend solely on one unbounded model context.
- Other work sessions require an actual accessible source or connector. Their availability is not implied by using Codex.
- Onboarding should gather all relevant profile categories, while allowing skipped answers and ongoing normal conversation.
- Models, reasoning levels, tools, and plugins must be available to the selected runtime and account.

## Acceptance scenarios

### Conversation and background work

A user starts a long research or coding task, asks an unrelated question, then redirects or cancels the original task. The assistant remains responsive and reports the actual task outcome.

### Voice, PDF, and reminder

The user forwards a PDF and sends a voice instruction: summarize it, save it under a named project, and send a reminder Friday at 09:00. The assistant preserves originals, transcribes the instruction, processes the PDF, saves the deliverable, and registers a timezone-aware reminder. The reminder survives container restart.

### File recall

The user asks to use the PDF sent yesterday. The assistant resolves the attachment through stored provenance and retrieves the original or extracted content without requiring re-upload.

### Profile lifecycle

An empty USER.md triggers onboarding. Later explicit preferences update the profile. Corrections replace outdated facts; a forget request removes the relevant durable profile/memory information, with backup and original-source retention limits disclosed.

Each agent/container serves one user and owns one workspace/profile. Durable
memory separates facts, project context, dated episodes and procedures.
A fact learned in an earlier conversation must remain retrievable after restart;
a later correction is current, while the prior value is available only for
historical questions. Missing evidence should produce an honest unknown. Daily
and weekly maintenance organize collected evidence without routine messages.
The implemented policy and narrow forgetting scope are in [memory.md](memory.md).

### Reflection

A daily review combines conversation and connected task/calendar evidence. Suggestions distinguish facts from hypotheses and avoid repeating dismissed advice. Weekly/monthly reviews can trace significant conclusions to source evidence.

### Persistence

Replacing the container preserves workspace files, profile, skills, task records, schedules, conversation mapping, and pending notifications. Restore from host backups is tested before considering deployment complete.
