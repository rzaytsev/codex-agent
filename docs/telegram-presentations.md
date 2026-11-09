# Telegram widgets and rich messages

Main and worker responses can optionally return a `presentation` alongside their
normal text, voice and files. The service validates it and queues one durable
message on the existing conversation route. No extra model or direct-send tool
is needed. Existing custom profiles receive the image-owned guidance on every
turn after recreation; personal AGENTS.md/SOUL.md/USER.md are preserved.

| Final presentation | Intended use | Transport |
| --- | --- | --- |
| `null` | Ordinary concise replies | Existing text messages |
| `{"kind":"rich","content":"...","actions":[],"state":null}` | Rich Markdown headings, tables, code, formulas, footnotes and collapsible details | `sendRichMessage` |
| `{"kind":"widget","content":"<html>...</html>","actions":[],"state":null}` | Small offline interactive explanations, diagrams and calculators | `sendWidget` in private chats/topics |

`text` is always required as a self-contained readable answer: up to 1024 UTF-16
units for a widget caption, or 3500 for a rich-message fallback. These conservative
service limits allow a single literal fallback without partially delivered
multi-message retries. Rich content allows 32768 characters. Widget HTML allows
32768 UTF-8 bytes and 4096 zlib level-9 bytes, checked before enqueueing. Invalid,
oversized or group-widget presentations use the complete ordinary text path.
Regular files/voice retain their existing delivery and snapshot rules.

Widgets use inline CSS/JavaScript, theme colors, buttons, SVG and local state.
Telegram runs the code on the viewer's device; the service never evaluates it.
There is no network, full browser, external resource loader, keyboard or form
input. Avoid internal scrolling; design at 320 px and below 560 px height.
Interactive widgets declare up to eight actions `{id,label,prompt}` and initial
`state` as a JSON-object string within 600 UTF-8 bytes. Action IDs use 1–64 ASCII
letters, digits, underscores or hyphens; labels are 1–80 characters and offered
requests 1–2000. Queries are enabled only for valid registered actions. Widgets
remain non-shared and private; inline/shared/group/wallet requests are rejected.

The service registers a widget only after Telegram returns its message receipt,
binding owner, conversation, session, actor and message. A callback must match that
record and an offered action. It atomically admits one ordinary main input and
query audit row, queues live state, and acknowledges before model execution.
Duplicate query IDs never run twice; a busy widget admits no second request,
and owner-wide admission is bounded at eight requests per minute. New sessions,
foreign owners/messages, disabled topics and unknown actions cannot admit work.
The original topic is derived from the stored message binding, not query text.

Callbacks are host-attributed widget events, never direct-owner text, approvals
or new profile facts. Telegram authenticates the viewer but cannot distinguish a
tap from background JavaScript; instructions require button-handler requests and
forbid polling. Callback data is an allowlisted ID, never arbitrary model input or
a slash command. The existing main queue serializes it with ordinary messages.

`TelegramWidget.chatData` is JSON `{revision,status,data,reply}`. Scripts render it
initially and on `chatDataChanged`, ignoring older revisions. The service owns
revision/status/reply; model state is under data. Input lifecycle queues queued,
working and completed/failed/cancelled/interrupted states to the original widget.
Completed means the agent input turn settled, not that a delegated background job
or real-world goal succeeded. Reply is a 200-byte preview; the full answer is sent
normally. Restart reconciles interrupted inputs without replaying agent work.
Older pending state revisions expire before sending; network ambiguity retains
uncertain outbox status. State updates are silent Telegram edits, not new messages.

Main-only `widget_read` lists the latest ten current-session widgets or reads an
ID. `widget_update({id,expected_revision,state})` queues a conflict-checked update;
read first because click-time revisions can be stale. Read-only mains can read,
not update; workers and internal reviews have neither tool. Workers can return
interactive final widgets whose callbacks enter the main queue. The service
validates the JSON envelope against Telegram's 1024-byte state limit.

The required caption carries the important explanation for search, notifications,
accessibility and clients without widget support. Local-only widgets continue to
work with empty actions and null state. HTML stays immutable after sending. Native-client review found an initialization failure in an initial
fragment demo. A full HTML document, explicit window bridge, guarded initialization
and ready() rendered correctly; browser previews alone do not establish this.
Reusable templates prefer that checked pattern.

Only definite API rejection (400/404) triggers a literal same-route text send.
Network or malformed-response failures stay uncertain; rate limits/server errors
retain normal bounded outbox retry behavior. There is no redirect to the default
chat. Service-created literal approval envelopes continue to bypass enhancements.
History records readable `text`; presentation source remains in the private
outbox/job result. Queued, API-accepted, rendered and owner-accepted are separate
states; tests cannot establish the last two.

## Recent API review — November 9, 2026

The [Bot API changelog](https://core.telegram.org/bots/api-changelog) and
[API reference](https://core.telegram.org/bots/api) were checked through 10.4.
Context7 independently supplied the rich-message contract; the latest widget
limits and rollout restrictions were checked against the live primary sources.

| Addition | Decision for these assistants |
| --- | --- |
| 10.4 HTML widgets | Implement local interactive explanations with captions; production private chats only, protected against forwarding |
| 10.1–10.3 rich messages | Implement rich Markdown delivery, including tables, formulas and details; preserve ordinary text as fallback |
| 10.3 rich buttons | URL links can be included in rich content; callback buttons need a separately authorized intake/interaction design |
| 10.3 stoppable message drafts | Deferred: the pinned SDK emits the completed structured answer, and draft stop events need binding to owned executions; existing typing and `/stop` remain available |
| 10.2–10.4 ephemeral messages | Deferred: one-owner linked groups currently use ordinary durable replies; ephemeral delivery requires a separate visibility/receipt policy |
| Private topic deep links | Telegram now supports them; existing private-topic routing already carries thread IDs. Automatic topic creation/renaming remains outside this change |
| Widget queries and private live state | Implemented: source-bound action admission, acknowledgment, revisioned state edits, main tools and interrupted-input recovery |
| Shared/group/inline widgets | Deferred: production only supports private widgets, and shared state would add cross-message lifecycle handling |
| Wallets, gifts, subscriptions, communities and managed bots | No automatic adoption: these do not help ordinary explanations and require different product/authority flows |

See [Telegram widgets](https://core.telegram.org/bots/widgets),
[sendWidget](https://core.telegram.org/bots/api#sendwidget),
[rich formatting](https://core.telegram.org/bots/api#rich-message-formatting-options)
and [sendRichMessage](https://core.telegram.org/bots/api#sendrichmessage).

## Verification

Run `node --test test/widgets.test.js test/presentation.test.js test/prompts.test.js
test/telegram-topics.test.js`, followed by the normal development checks.
Fixtures cover compressed/UTF-8 limits, invalid output, main/worker durable
delivery/history, private topic and group routes, cancellation, literal approvals,
definite rejection and uncertain recovery. Real-model generation, target-image
checks, Telegram API acceptance and device rendering require separate evidence.

For an explicitly authorized live test, run `node scripts/widget-demo.js --send`
in the selected configured bot container. It queues one demonstration for the
existing owner DM, without initializing another service, recovering execution or
starting a poller. Press an offered button in Telegram. `node scripts/widget-demo.js
--status UUID` reports only binding/state/admission/edit metadata for that widget.
The helper sends real messages; ordinary unit tests do not.
