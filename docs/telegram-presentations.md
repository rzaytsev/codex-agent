# Telegram visual explanations and rich replies

HTML widgets are disabled. New main/worker answers use text or rich messages;
use the built-in `image_gen` imaging model when a graphical explanation helps.
The service delivers selected PNG/JPEG images through the ordinary artifact/photo
path. No separately billed image API or API-key fallback is enabled.

## Image generation and delivery

`templates/PRESENTATION.md` is image-owned guidance loaded on ordinary main/worker
turns, including existing instances after recreation. Custom workspace profiles
are preserved. It asks for readable labels, checked facts and visual inspection,
plus a concise text explanation. Internal reviews receive no image-production
guidance; read-only/research scopes cannot generate deliverables.

Ordinary writable turns enable the native Codex image-generation feature. Actual
tool access depends on the installed CLI and account. A flag or prompt does not
prove access; report unavailable generation honestly. Do not substitute a script
or HTML screenshot for the imaging model, or silently switch to API billing.

The trusted CLI saves images under its own `generated_images/<thread UUID>`.
The service observes the thread ID and snapshots existing filenames at thread
start. Only newly created PNG/JPEG files in that thread are considered, so resumed
threads do not resend old pictures. The collector accepts at most four images,
16 MiB combined, uses bounded reads, and rejects symbolic/hard links, changed
files and invalid image signatures. It copies approved bytes into a new private
workspace `outputs/imagegen-*` directory. Existing artifact route checks, snapshots,
hashes and photo/document delivery rules still apply.

In isolated main chat, the model needs no shell access to the owner's workspace:
call `image_gen`, inspect its returned image and return `files=[]`. The service
stages the images after discarding arbitrary model file paths. Offline workers
use their existing bounded capture hook. Ordinary file-capable turns may instead
copy the selected image into workspace outputs and return its absolute path.

Queued files, Telegram API acceptance and device viewing remain distinct gates.
No second poller or alternate provider is required. Generated artifacts stay
private; do not put account files or operational data in output paths.

## Disabled widget paths

Widget tools are absent from advertised bundles and rejected by the direct tool
validator. Callback admission is disabled. New widget results fall back to their
readable text; pending widget payloads also become text without `sendWidget`,
HTML attachments or a route change. Pending widget state edits expire rather than
being reported as delivered. Historical records and module fixtures are retained;
legacy tests explicitly enable that machinery and do not establish availability.
Native task cards, clarification choices and Stop are separate and remain enabled.

This replaces the former inline-widget and browser-HTML fallback behavior.
Telegram currently denies general bots with `INPUT_MEDIA_WIDGET_NOT_ALLOWED`,
confirmed in the [official issue](https://github.com/tdlib/telegram-bot-api/issues/947).
The disabled policy does not automatically reverse if Telegram restores access.

## Rich replies

Use `presentation=null` for ordinary replies. Optional rich Markdown uses
`{"kind":"rich","content":"...","actions":[],"state":null}` with headings,
tables, formulas and collapsible details. Keep content within 32768 characters
and complete readable fallback text within 3500 UTF-16 units. Definite API
rejection can fall back to literal text; uncertain network sends are not replayed.

## Validation and rollout

Run `node --test test/generated-images.test.js test/presentation.test.js
test/widgets.test.js test/prompts.test.js test/telegram-topics.test.js`, then the
standard development checks. Fixtures cover staging to actual photo transport,
old-file suppression, role limits, stale widget suppression and route boundaries.

Rebuild/recreate selected instances serially while idle, preserving data, auth,
profiles, security/resource settings and mounts. No data migration or profile
replacement is needed. Verify current CLI capability and a model-generated image
on an authorized live run, its exact artifact bytes and delivery, separately from
health. Run live generation only with explicit authorization; it consumes account
quota. Existing widget demos are historical and should not be used for acceptance.

## Task cards, choices and native reply previews

Private task cards are durable, owner/conversation/job/session-bound native inline
keyboards. Cancel uses the existing settlement path: running work stays Stopping
until owned execution exits. Completed cards offer Open result, resending immutable
prepared text/presentation/artifact snapshots without another model call. Cards
remain bound to the original task after a new session. Unknown sends are never
replayed after restart; recovery refreshes only confirmed message receipts.

Main-only `ask_clarification` queues one question and 2–6 native options. A choice
is consumed once as an event, never direct-owner approval or an owner fact.
Free-form intake expires pending questions; session changes invalidate them.
Forged, foreign, stale and wrong-topic callbacks are rejected before persistence.

Main-only `stream_reply` appends genuinely new user-facing fragments, with sequence
idempotency and a bounded temporary preview. This is paragraph streaming through
the existing pinned SDK, not a token-delta guarantee or timed playback. Telegram
`sendMessageDraft` uses native Stop and discards the stopped preview. A Stop event
must match the exact active private chat/topic/session/input/draft; it aborts the
owned execution and suppresses late output. Draft failure leaves final durable
response delivery available. Restarts interrupt drafts without replay. Neither
service tool is advertised to workers, internal reviews, groups or read-only turns.
Image-owned `templates/CONTROLS.md` reaches existing instances each turn without
replacing custom workspace profiles. See `test/controls.test.js` and
`test/reply-stream.test.js`; live API/device acceptance is recorded privately.

The native Stop parser accepts the exact decimal-string `draft_id` returned by
[Telegram's serializer](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp#L3943),
as well as numeric IDs. The reference labels this field Integer, but the serializer
writes `td::to_string`. Only canonical safe IDs issued by this service can match;
whitespace, exponents, leading zeros, rounding and foreign/stale IDs are rejected.
Native drafts own the progress indicator. Plain typing starts only after draft
failure and is stopped on pause, cancellation or completion.
