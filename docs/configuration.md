# Configuration reference

Use templates/agent.env.example as the authoritative creation template and
src/config.js for application validation. Each private instance has its own
agent.env. Recreate its container after env changes. Empty model names use the
runtime default; available names/reasoning levels depend on the signed-in account.

| Setting | Default / contract |
| --- | --- |
| AGENT_NAME | Created instance name; launcher pins the matching Compose project |
| TELEGRAM_BOT_TOKEN | Empty setup mode; unique token per instance |
| TELEGRAM_ALLOWED_USER_IDS | Exactly one positive numeric owner ID, or empty deny-all setup mode |
| WORKSPACE_HOST_PATH, CODEX_HOST_PATH | Absolute, separate existing host directories outside source sync |
| TIMEZONE | UTC for new instances; use an IANA timezone explicitly |
| MAIN_MODEL / MAIN_REASONING | Runtime default / low |
| WORKER_MODEL / WORKER_REASONING | Runtime default / high |
| RESEARCH_MODEL / RESEARCH_REASONING | Runtime default / medium |
| REVIEW_MODEL / REVIEW_REASONING | Runtime default / high |
| MAX_WORKERS | 2; accepted range 1–8 |
| MAIN_TIMEOUT_SECONDS | 180; range 10–3600 |
| WORKER_TIMEOUT_SECONDS | 1800; range 10–86400 |
| MAX_ATTACHMENT_MB | 20; range 1–20 for downloads; output cap is independently 49 MiB |
| PROACTIVE_ENABLED | true; daily/weekly/monthly review schedules after first owner interaction |
| DAILY_REVIEW_CRON | `0 19 * * *` |
| WEEKLY_REVIEW_CRON | `0 18 * * 0` |
| MONTHLY_REVIEW_CRON | `0 18 1 * *` |
| QUIET_START_HOUR / QUIET_END_HOUR | 22 / 8; 0–23; equal disables quiet hours; affects proactive deliveries |
| CLEANUP_ENABLED / CLEANUP_CRON | true / `0 3 * * *` |
| MEMORY_ENABLED | true; structured capture/recall remains a distinct feature from scheduled maintenance |
| MEMORY_DAILY_CRON / MEMORY_WEEKLY_CRON | `15 3 * * *` / `45 3 * * 0` |
| MEMORY_MAX_BATCHES | 4; range 1–20 per maintenance pass |
| WHISPER_MODEL / WHISPER_LANGUAGE | base / automatic language; first download needs network |
| TTS_VOICE | en; eSpeak voice, e.g. en/es/ru; synthetic speech |
| GOOGLE_MAPS_API_KEY | Empty; optional Google Places/Routes, separately billed |
| BROWSER_ENABLED / BROWSER_EXECUTABLE | true / /usr/bin/chromium |

Reasoning parser accepts minimal, low, medium, high, xhigh, max and ultra; that is
not proof every model supports every level. Boolean flags are disabled by the
literal string false. Cron expressions use five fields and the instance timezone;
all six configured expressions must have a valid next occurrence at startup.
One-shot schedule tools require an ISO timestamp with an explicit offset.

Reflection schedules reconcile changed cron/timezone settings after recreation.
Disabling proactivity disables these schedules and blocks queued reviews from
starting; running reviews and already queued notifications are not undone. An
explicitly cancelled schedule stays cancelled with unchanged configuration.
Changing its cron/timezone or re-enabling proactivity restores it. See
[security and reliability](security-reliability.md) for failure and cancellation limits.

## Launcher and container-owned paths

The launcher supplies AGENT_ENV_FILE and AGENT_INSTANCE_DIR, pins AGENT_NAME and
the Compose project, and explicitly selects the optional override. Do not set
COMPOSE_FILE to select personal overrides; use the per-instance override file.
Ambient host workspace/Codex path variables are cleared to prevent wrong mounts.

Compose fixes WORKSPACE_DIR=/workspace, CODEX_HOME=/data/codex,
HOME=/workspace/state/home and SEED_DIR=/run/agent-seed. The image sets
WORKSPACE_PYTHON_BASE, speech PYTHON_BIN and persistent UV_* paths. For local
synthetic tests these can be supplied directly to the process. Do not change
container paths without auditing SDK environment, backups and workspace helpers.

Private backup settings are JSON, separately documented in [backups](backups.md).
Optional Codex MCP/plugins live in the selected persistent Codex home; the runtime
app-server probes report availability without proving every operation's scope.

## ChatGPT authentication

No extra secret or public callback URL is required for Telegram /auth. Service
account processes and SDK turns select ChatGPT-only login and file-backed
credentials in the existing CODEX_HOME. Login attempts have a ten-minute service
deadline; routine account checks run once per minute. See
[authentication](authentication.md) for first start and account replacement.
