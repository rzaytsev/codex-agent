# Implementation status

This document describes reusable source behavior. Personal deployment receipts
and operational history are private and are not public runtime evidence.

## Implemented

- Continuous learning with separate idle proposal/validation turns, sourced
  versioned trials, managed profile projections, image-owned core, bounded questions
  and explicit rollback. Synthetic tests verify storage/lifecycle contracts; actual
  helpfulness needs ongoing outcome evidence. See [learning](learning.md).

- Pinned tdl image installer, per-instance private Telegram user-session wrapper,
  owner-only `/tdl_auth` QR login/status/cancel with staged owner verification,
  interactive `bin/agent tdl-login NAME` fallback for 2FA and read-only mounted `telegram-read`
  skill. Real reading requires owner login and acceptance on the deployed image.
  See [Telegram reading](telegram-read.md).

- Operator-managed desired plugin list, reconciled after verified startup login
  and `/auth` completion, with bounded CLI installs into persisted CODEX_HOME and
  controlled failure reporting. Synthetic plugin/auth tests cover installation,
  preservation, failure and model-readiness gating. Provider access still needs
  account authorization and live acceptance. See [configuration](configuration.md#desired-plugins).

- Optional authenticated agent mailbox, saved task requests with direct owner
  acceptance, attributed replies/status, and a laptop skill over SSH. Source
  tests cover isolation and recovery; live acceptance is instance-specific.
  See [agent messaging](agent-messaging.md).

- Telegram /auth sign-in, replacement, status/cancel and signed-out /start; managed device-code login with persisted credentials and active-work draining. See [authentication](authentication.md) for recovery and live acceptance limits.

- Node.js 24+ application using pinned Codex TypeScript SDK/CLI 0.159.2. This resolves the original app-server proposal in favor of a smaller SDK integration; application-owned MCP tools provide scheduling and orchestration.
- Private-chat numeric allowlist checked before persistence/download; outgoing delivery and tools also enforce the allowlist.
- SQLite persistence for inputs, conversation history, thread IDs, jobs, schedules, reflection coverage, and delivery state.
- Main conversation low reasoning by default; asynchronous worker/research/review profiles with configurable models/reasoning and bounded concurrency/timeouts.
- Authenticated local MCP bridge for history, background jobs, cancellation, profile/personality writes, and reminders/task schedules.
- USER.md onboarding and ongoing updates through agent instructions and atomic profile tools; SOUL.md behavior configuration. Model adherence needs live acceptance and is not asserted from unit tests.
- Original attachment and forward provenance storage, PDF text extraction, image model input, CPU Whisper transcription and local voice generation.
- Formatted Telegram text, chunking, files and requested voice; durable delivery queue with rate-limit retry and explicit uncertain delivery state.
- Daily/weekly/monthly reflection jobs after first authorized interaction; connected sources discovered through configured Codex tools. No external sources preconnected.
- Docker Compose deployment with independent env configs and host mounts per agent, protected persistent authentication, no host ports or Docker socket, and host-backup documentation.
- Default templates plus a non-overwriting additional-instance generator.
- Collision-resistant attachment storage, cancellation-aware media/voice work,
  turn capability cleanup, transactional final responses, fair queue selection
  and validated/reconciled reflection schedules. See [security and reliability](security-reliability.md)
  for exact contracts, tests and remaining boundaries.

## Limits and remaining acceptance

No Telegram token or allowed IDs are populated by development. Agent configs live in private/instances/NAME/agent.env; there is no root/default instance. Each instance needs a ChatGPT device login, available through Telegram /start or /auth. End-to-end Telegram, real model delegation, file recall, onboarding, reflection quality, and real voice transcription require live credentials/input.

Voice generation is local eSpeak (robotic). Whisper needs first-use model download. Scanned-document OCR is available as an agent-operated tool rather than unconditional automatic OCR. Albums are processed per incoming message. PDF errors preserve originals but do not silently claim successful extraction.

Reviews cover history and accessible connectors; daily/weekly/monthly schedule defaults can be changed. Successful review completion advances coverage; failure retains the previous boundary. Quiet hours defer proactive notification delivery, not explicitly requested reminders. Reflection history queries are bounded and require targeted lookup for larger periods.

No exactly-once delivery claim: crashes/network ambiguity can leave uncertain messages requiring review. Interrupted execution is not retried blindly. No arbitrary automatic resume/replay of remote mutations. Cancellation cannot undo an external action already completed.

Full autonomy executes code with container access to its workspace/auth state and configured tools. Runtime filesystem mounts define host access. Each instance accepts one Telegram owner; independent people use separate agents. Container isolation is not a guarantee against every malicious generated program.

Forgetting can update profile/memory files; original transcripts, Codex session files and backups require an explicit retention/erasure policy. No automatic comprehensive erasure is implemented.

Templates initialize missing files only. Generated skills follow Codex's native .agents/skills layout. Dependencies added by generated code should be installed into writable workspace directories because the image root is read-only.

## Public blueprint and private instances

- bin/agent selects a private instance explicitly for every operation.
- Per-instance env files, overrides and profile seeds live under ignored private/.
- Runtime data remains outside the source checkout; missing mount roots fail.
- Generic skills are read-only; editable private copies require explicit mounts.
- Backup helpers read explicit private host settings and instance lists.
- Public Git candidates can be checked with scripts/check-publication.py.

## Verification boundaries

Run npm run check, npm test and the Python backup suite for local validation.
Compose tests resolve two synthetic instances without a Docker daemon. Local
setup/seed tests make no model calls and send no Telegram messages. No tests
assume access to real credentials or private instance directories.

Image builds, host permissions, deployed health, actual Telegram interaction,
account connections and a full backup/restore drill must be checked on the chosen
runtime. Passing local tests does not establish those deployment gates.
