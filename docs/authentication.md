# ChatGPT login in Telegram

Start the container with its Telegram token and one owner configured, then open
its private chat and send `/start`. If no ChatGPT login is saved, the service
offers device-code login before running the model. An owner who previously
contacted the bot receives one missing-login notice; Telegram cannot initiate a
brand-new chat. Ordinary requests wait in the durable input queue.

- `/auth`: sign in or replace the current ChatGPT account. Repeating it during
  login shows the existing code rather than creating another attempt.
- `/auth status`: read current account status, masked email and plan when known.
- `/auth cancel`: stop the pending attempt.

Open the official verification link and enter the one-time code in your browser.
Use a private window or switch browser accounts if the wrong account is selected.
Some accounts require enabling device-code login in ChatGPT security settings;
workspace administrators can restrict it. The bot waits up to ten minutes per
attempt. Passwords, tokens and authentication files must never be sent to the bot.

## Switching accounts

The service pauses new model turns and workers, including maintenance, and waits
for active work to finish before starting login. `/stop` and `/cancel <task-id>`
can stop that work; cancellation cannot undo actions already performed. Telegram
polling, delivery, control commands and plain reminders remain available. `/usage`
does not start another Codex account process while login is in progress.

Codex performs its native managed OAuth flow and saves the new credentials only
after authorization and workspace checks. The service does not log out first.
Failed or cancelled attempts normally retain the existing login. Cancellation can
race with successful authorization, so the service rereads saved credentials and
reports the current account rather than promising that the old account remains.

Every completed or uncertain attempt starts a fresh model thread. The Telegram
owner, profile, personality, local history, memory, files, jobs and schedules are
preserved. Queued, unstarted work can continue after login. Failed/interrupted
actions are not replayed. The new account's model access, limits and ChatGPT
connectors apply; this does not grant any new Google or other external consent.

## Persistence and recovery

Authentication uses the existing per-instance `CODEX_HOME` and explicitly selects
`cli_auth_credentials_store="file"` and `forced_login_method="chatgpt"` for service
account processes and SDK turns. Codex owns token storage and refresh. Protect the
directory and `auth.json`; the existing persistent mount and backup policy apply.
There is no API-key fallback and no change to Compose identities or mounts.

Login runs through a private stdio app-server process with a sanitized environment.
The service holds the one-time code in memory; the delivery queue contains only
an opaque attempt reference. Codes and raw account errors do not enter model
history, memory, application logs or the durable outbox. The code is necessarily
visible in the owner's Telegram chat. No auth-management MCP tool is exposed.
Forwarded commands cannot initiate login.

On shutdown the login process stops. On restart old challenge references expire,
saved authentication is checked, and an interrupted-attempt marker prevents an
old model thread from being resumed after an uncertain account switch. A temporary
account-check failure blocks new model work without declaring the account logged
out; checks retry once per minute and `/auth status` requests a fresh check.

Health reports `setup:codex-login` when signed out, `setup:codex-login-pending`
while draining/login is pending, and `degraded:codex-auth` when a check fails.
`ready` confirms locally readable ChatGPT auth, not model eligibility or token
validity at the next remote request. Use `/auth` if a model reports expired or
revoked authentication. Telegram transport health remains a separate condition.

`bin/agent login NAME` remains an operator fallback. Do not run it concurrently
with model work or a Telegram login attempt; use `/auth` for coordinated switches.

## Verification

`test/auth.test.js` covers owner/forward boundaries, signed-out startup, queuing,
active-work draining, replacement, cancellation, timeout, restart recovery, early
and unrelated notifications, private errors, transient account outages, and
instance isolation. Subprocess tests use synthetic responses; the installed
0.159.2 runtime also supports the device-code schema and an empty-home account
read. These checks do not establish a real browser login or Telegram delivery.

Live acceptance: log into a fresh test instance, send a request, recreate it and
verify it still answers; then `/auth` into a second account, check `/auth status`
and `/usage`, and verify retained local memory. Also cancel a replacement attempt.
The owner must complete browser authorization themselves.

Sources checked against the pinned runtime:
- [Authentication](https://learn.chatgpt.com/docs/auth).
- [App-server auth endpoints](https://learn.chatgpt.com/docs/app-server#auth-endpoints).
- [Pinned device-code persistence](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/login/src/device_code_auth.rs).
- [Pinned account handler](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server/src/request_processors/account_processor.rs).
