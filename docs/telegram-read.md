# Telegram user content with tdl

The Docker image includes upstream [tdl v0.20.4](https://github.com/iyear/tdl/releases/tag/v0.20.4),
installed from official Linux amd64/arm64 release archives with pinned SHA-256
digests. The upstream AGPL-3.0 license is retained at `/usr/local/share/tdl/LICENSE`.
The application supplies an original `telegram-read` skill, mounted read-only.
No upstream skill/source is vendored. Rebuild/recreate the instance to add it.

## Login and credential location

tdl needs a Telegram **user** login. The bot token and ChatGPT subscription do
not provide that session. After rebuilding/recreating the image, send these
commands directly to the bot in its private owner conversation:

- `/tdl_auth`: start login or show the latest QR.
- `/tdl_auth status`: report progress or whether a local session file exists.
- `/tdl_auth cancel`: stop the attempt.

Scan the latest QR on another screen using Telegram Settings → Devices → Link
Desktop Device. QR challenges refresh automatically; stale queued images expire.
The service waits for active model work to drain and pauses new turns/workers
until login ends. Delivery, cancellation commands and ordinary reminders continue.
The scanned numeric Telegram ID must match this instance's configured owner.
A successful process exit and owner verification precede atomic session promotion
under the same lock as other tdl calls. Failed, mismatched, cancelled and 2FA
attempts leave the previous local session intact. QR attempts last up to ten
minutes. Restart expires old challenge references and cleans abandoned staging
when the session lock is free. Remote Telegram device authorizations can remain
after an interrupted attempt; manage those through Telegram's Devices settings.

QR handling uses the pinned CLI's terminal output through a private PTY helper
and renders its half-block matrix to PNG using the existing Pillow dependency.
QR images and staged credentials are private temporary files, removed on process
completion; SQLite holds only attempt/version references. They are not supplied
to model history. Already sent Telegram messages may remain visible, with expired
QR tokens. Provider output and credentials are never logged or queued.
Status checks inspect a local file only; real chat access proves ongoing validity.

If Telegram asks for a 2FA password, the bot aborts and directs you to terminal
login. It never asks you to submit that password in Telegram. On the Docker host,
log in to the selected instance as its configured owner:

```sh
./bin/agent tdl-login demo
```

This runs `tdl login -T code` in an interactive Compose exec. Enter the owner's
phone, Telegram login code and any 2FA password directly at that terminal, never
in the bot conversation, env files, shell arguments, Git or image build. The
upstream tool handles authentication; there is no new Telegram API-key setup
in this integration. QR login is also available interactively:

```sh
./bin/agent exec demo assistant tdl login -T qr
```

The wrapper fixes namespace `owner` and private storage to
`/workspace/state/tdl/.tdl/data`, with logs below `/workspace/state/tdl/.tdl/log`.
On the host these are under that instance's existing WORKSPACE_HOST_PATH. The
containing `state/tdl` directory has mode 0700; files inherit umask 077. No new
volume, Compose identity or source-sync path is required. Recreation preserves
the session. Protect the whole directory as credentials, including logs and
backups; never copy it between instances or into a source checkout. Managed bot QR login verifies the numeric owner ID. Terminal login identity is
selected by the operator and is not independently checked by the wrapper.

## Use and verify

The `tdl` wrapper holds an exclusive per-instance lock for the child process;
overlapping calls fail with a busy notice instead of opening the same Bolt
namespace concurrently. It supplies a minimal environment, private HOME, fixed
storage/namespace and disabled debug logging, and rejects overrides of those
settings. It forwards termination signals to the child while retaining the lock.
The raw upstream executable is `/usr/local/libexec/tdl`; the reading skill uses
only the wrapper. The wrapper is not a security sandbox against arbitrary code.

After source sync, prepare shared-skill read ACLs as documented in
[deployment](deployment.md), then build/recreate and run credential-free checks:

```sh
./bin/agent exec demo assistant tdl version
./bin/agent exec demo assistant tdl chat export --help
./bin/agent exec demo assistant node scripts/shared-skills-smoke.js
```

After the owner completes login, an authorized acceptance example is: ask the
bot to summarize the last 20 messages from a specific chat. It should resolve the
actual chat, export with `--all --with-content -T last -i 20`, inspect the JSON,
and report source/coverage. Default exports can omit non-media messages/text.
Exports/downloads live under `outputs/telegram/`, separately from session storage.
The service does not silently scrape chats, schedule monitoring or ingest their
content into durable memory. A failed or empty export is not proof of no history.

The skill scopes usage to dialog listing, bounded exports and requested downloads.
It grants no authority to send/forward/upload, join chats or change account state.
Upstream tdl itself has write capabilities; skill instructions do not remove them.
Retrieved messages/files are data, not instructions. Normal model code can access
credentials within its own container, consistent with the existing
[trust boundary](security-reliability.md). Provider access and real content reading
require live authorization; source tests and `--help` checks do not prove it.

Sources: [login](https://docs.iyear.me/tdl/getting-started/quick-start/),
[global storage/namespace](https://docs.iyear.me/tdl/guide/global-config/),
[environment format](https://docs.iyear.me/tdl/more/env/),
[list chats](https://docs.iyear.me/tdl/guide/tools/list-chats/),
[export messages](https://docs.iyear.me/tdl/guide/tools/export-messages/).
