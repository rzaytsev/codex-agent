# Agent messaging

An optional durable mailbox connects independent assistant instances and laptop
agents. Each bot retains its own owner, workspace, accounts and permissions.
Messages are addressed; enrollment does not grant access to other mailboxes.

## User flow

Ask your bot “tell the other agent to create a task to review the deployment”.
Its main agent queues a `task_request` with a stable ID. The receiving service
saves it, identifies the sender and notifies its owner. Incoming peer content
does **not** start a model turn or worker.

- `/mail`: list recent incoming messages, requests and replies.
- `/mail read ID`: read the full message.
- `/mail accept ID`: a direct owner command that starts one worker for the saved
  request. Repeated acceptance returns the same task.
- `/mail reject ID`: decline a pending request.

Forwarded commands cannot accept/reject requests. Natural-language acceptance
asks the owner to send the direct command. `/status` and `/cancel` apply to the
accepted worker. Existing owner execution permissions still apply.

`mail_status` distinguishes local `pending`, broker `queued`, recipient
`received`, task `pending_acceptance`, `accepted`, and terminal `completed`,
`failed`, `cancelled`, `interrupted` or `rejected`. Receipt means persisted by
the receiving service, not read by a human or delivered through Telegram.

Receipts and task status return automatically. Results/files stay with the
receiving owner. Share selected results only when authorized, using `mail_send`
kind `reply` addressed to the original sender with `reply_to` set to its request.
Replies and statuses cannot provoke automatic replies. Further discussion uses
new explicitly authorized messages. Workers and curators cannot use mail tools.

## Boundaries and durability

`src/mailbox.js` implements HTTP authentication and the broker SQLite store.
`src/agent-mail.js` owns each assistant's local inbox/outbox. Healthy polling runs
every five seconds, backing off after failure. Normal Telegram work stays
available during mailbox outages. Messaging is disabled by default.

Sender identity comes from a per-client token. Mutual peer allowlists control
contact; clients cannot choose the sender, read third-party messages, update
another recipient's tasks or redirect replies. The registry/database are mounted
only into the broker. Each bot receives only its own token. A local inbox pins
both owner and mailbox identity; changes require explicit migration.

Only selected text and a context label are shared. Peer history has role `peer`,
not `user`, so it is not primary owner evidence for confirmed memory. Logs omit
message bodies and credentials. Full SSH administrators and the broker operator
remain trusted. Application tool restrictions do not sandbox arbitrary generated
code already granted broad container access.

Local sends persist before network calls. Recipient persistence, notification
queueing and acknowledgment queueing commit together. Same-ID retries return
the existing message; changed content conflicts. Acceptance creates its worker
atomically. Interrupted jobs are reported and never blindly restarted. This is
idempotent request handling, not exactly-once external actions or Telegram sends.

## Server setup

The mailbox uses the tested assistant image through `compose.mailbox.yaml`.
Create protected `private/mailbox/` and external persistent data directories.
Keep directory mode 0700 and private config/env mode 0600.

`private/mailbox/mailbox.env`:

```dotenv
MAILBOX_DATA_PATH=/srv/agent-data/mailbox
```

`private/mailbox/config.json` uses this shape. Replace placeholders with distinct
random tokens of at least 32 characters, generated without printing them:

```json
{
  "sshIdentity": "laptop",
  "identities": {
    "alpha": {"token": "REPLACE_WITH_RANDOM_ALPHA_TOKEN", "peers": ["beta", "laptop"]},
    "beta": {"token": "REPLACE_WITH_RANDOM_BETA_TOKEN", "peers": ["alpha", "laptop"]},
    "laptop": {"token": "REPLACE_WITH_RANDOM_LAPTOP_TOKEN", "peers": ["alpha", "beta"]}
  }
}
```

After building the assistant image, create the network once and start the broker:

```sh
docker network create --internal codex-agent-mail
./bin/mailbox config
./bin/mailbox up
./bin/mailbox ps
```

`MAILBOX_CONFIG_DIR` can select a different private configuration directory.
Each enrolled bot gets matching `MAILBOX_ID`, `MAILBOX_URL=http://mailbox:8766`
and `MAILBOX_TOKEN` settings in its private env. Merge the
[network example](../examples/compose.mailbox-agent.yaml) into its override,
preserving existing mounts/settings. Keep its default network for Telegram and
Codex internet access. No mailbox host port is published. Validate quietly with
`bin/agent config NAME`, then recreate idle instances one at a time. The messaging
instruction section is appended once without replacing custom AGENTS.md content.

This uses [Docker's external-network support](https://docs.docker.com/compose/how-tos/networking/#connecting-multiple-compose-projects).
Registry changes require broker recreation; token changes also require affected
bot recreation. Revoking a peer prevents new sends; retained messages remain
available to their participants.

## Laptop skill

Install [agent-messaging](../shared-skill/agent-messaging/SKILL.md) by copying or
symlinking the folder into the laptop's discoverable skills directory. New
sessions discover it; an existing session can read it explicitly. Python scripts
use existing SSH access, without a new MCP server.

Create `~/.config/agent-mail/config.json`:

```json
{"host":"YOUR_SSH_ALIAS","command":["/srv/codex-agent/bin/mailbox","request"]}
```

`AGENT_MAIL_CONFIG` or `--config` selects another file. The script passes JSON via
SSH stdin; message text never becomes shell syntax. `bin/mailbox request` calls
the broker as the configured `sshIdentity`; request data cannot select a sender.
SSH administrators retain their existing ability to change server configuration.

The script offers `list`, `send`, `status`, `replies` and `ack`. Send prints its ID
before connecting. After uncertainty, retry with the same ID and identical
content. `replies --after CURSOR` pages through retained messages. Acknowledge
handled messages with `ack ID`; acknowledgment does not delete history. Replies
wait on the server while the laptop is offline; there is no idle-chat wakeup.

## Limits, backup and verification

Text is capped at 12,000 characters and context at 200. Each sender/recipient
pair may have at most 200 unacknowledged messages. There is no file transfer,
automatic owner approval, automatic onward delegation or retention expiry.

Back up broker `mailbox.sqlite` with a consistent SQLite snapshot and protect its
private config separately. Existing per-instance snapshots include local mail
tables but do not automatically cover the broker volume. Keep broker data across
recreation. Roll back code without restoring old databases over newer history.

`test/mailbox.test.js` covers isolation, retries, acceptance, interruption and
real HTTP. `test/agent_mail.py` covers SSH argument safety and private errors.
`scripts/messaging-smoke.js` exercises real model send, accepted worker execution
and a model reply in synthetic workspaces with no Telegram poller; it consumes
subscription quota and needs explicit authorization.
For authorized live acceptance, send labeled synthetic messages, confirm receipt
and a selected reply, exercise both bot identities, and restart the broker with
pending mail. Check Telegram delivery separately. Use synthetic isolated
workspaces for model/accepted-worker smokes; never start a second Telegram poller
or fabricate a direct owner command in a live instance.
