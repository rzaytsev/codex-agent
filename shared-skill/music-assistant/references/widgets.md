# Telegram music explanation widgets

Use a widget when local stepping, comparisons or highlighting help explain the
music. A concise text answer or native rich table is better for a simple result.
Follow the target turn's image-owned presentation guidance; the local renderer
targets the current `{kind,content,actions,state}` final presentation contract.
It does not send Telegram messages or call a model.

## Choose a lesson template

| Template | Interaction | Musical purpose |
| --- | --- | --- |
| `templates/melody.json` | Step through a note contour | Phrase direction, duration, steps and leaps |
| `templates/intervals.json` | Compare pairs above a common note | Minor/major third, fourth, fifth and octave in semitones |
| `templates/scale.json` | Highlight degrees 1–8 | Note spelling, scale steps and tonal function; major/natural minor |
| `templates/chords.json` | Step through chord tones/progression | Distinguish a chord's notes from melodic succession |
| `templates/harmony.json` | Show/hide the proposed second voice | Compare the voices and explain changing diatonic thirds |

These files are **synthetic teaching examples**, not findings about an owner's
recording. Copy a relevant JSON file into the private project, replace its notes,
timing, labels, explanations, caption and evidence label from checked analysis,
then render it. Do not change a scale's tonic/mode without also updating its
lesson copy. The shared `templates/widget.html` supplies the standalone inline
CSS/JS/SVG shell. Do not load all lesson templates for a small question.
Keep its complete HTML/head/body document and guarded `window.TelegramWidget`
initialization when customizing it. Render locally before optional `ready()`;
absent bridge methods must leave local navigation usable. This follows the
native-client-tested initialization pattern, without assuming every HTML
fragment or every bridge call fails in Telegram.

The standard-library renderer works with ordinary Python 3; it does not require
the scientific environment or a new `music widget` command:

```sh
python3 /path/to/music-assistant/scripts/widget.py /private/project/lesson.json \
  --out /private/project/explanation-01
```

It writes `widget.html` for inspection and `response.json` with final `text`,
`voice:false`, `files`, `outcome:null`, `checkpoint:null` and `presentation`.
Read this JSON and return its content in the ordinary structured final response;
do not send its JSON/HTML as a separate chat message. Preserve any real task
outcome/checkpoint rather than blindly replacing it with the example nulls.
Do not attach the HTML as a document in place of `presentation.content`.

## Use actual analysis and pair it with sound

For the helper's **monophonic** analysis, select a bounded note window:

```sh
python3 /path/to/music-assistant/scripts/widget.py \
  --analysis /private/project/phrase/analysis.json --start-note 0 --note-count 4 \
  --attach /private/project/phrase/excerpt.wav \
  --attach /private/project/phrase/estimated.mid \
  --out /private/project/melody-widget-01
```

The adapter keeps note estimates and their source times explicit. It refuses a
polyphonic estimate as an identified melody. To explain candidate simultaneous
intervals from a mix, copy only the relevant note pairs into the intervals
template, label them estimated, and retain the uncertainty in the caption.
Neither a pretty contour nor an interval name proves which singer made a note.

For an existing scale-based second-voice proposal:

```sh
python3 /path/to/music-assistant/scripts/widget.py \
  --harmony /private/project/harmony/harmony.json --start-note 0 --note-count 4 \
  --attach /private/project/harmony/together.wav \
  --attach /private/project/harmony/harmony.mid \
  --out /private/project/harmony-widget-01
```

For an interval lesson, use `music reference` or `scripts/music.py reference` to
make the actual listening exercise/MIDI, then pass those existing paths through
`--attach`. The renderer never synthesizes or embeds sound. A waveform, audio
element, video element, browser audio API or “Play” button is not supported in
these Telegram widgets. State that listening/editing files are separate.

Attach only the original/reference/guide files relevant to this explanation.
Time units are explicit: hand-authored lesson examples can use beats, while
analysis adapters retain seconds from the analysis excerpt. Source timestamps
in captions add the excerpt offset. For a separated crop, also account for its
parent-recording offset as documented in [tools](tools.md). Do not silently
rebase MIDI, guide audio or the source recording to a different time origin.

## Optional offered requests and live state

By default all buttons are local: no callbacks, agent requests or server state.
When the target runtime advertises the callback extension, use
`--agent-requests` to include the lesson's explicit `actions` plus initial
`state:'{"step":0,"show_harmony":true}'`. Offer at most two useful requests in
this phone layout. For real analysis, replace the template's synthetic prompt
with a bounded request that names the actual selected notes, source passage and
intended work. Never leave a demo action describing a different song.

Each visible agent button maps to its registered action ID and calls
`TelegramWidget.request(id)` synchronously on that click. The templates never
request at startup, use timers or poll. Local Next/Back/voice toggles do **not**
tell the agent which step the user is viewing. Offered prompts must therefore
describe their fixed scope, not claim “the currently selected note” will be sent.
Callback events are not typed owner instructions, approvals or new authority.

The template handles accepted, busy, expired, rate-limited, failed and rejected
requests, disables agent buttons while work is pending, and keeps local visual
exploration available. It reads the revisioned `TelegramWidget.chatData` envelope
initially and on `chatDataChanged`, ignores old revisions, and treats reply text
as text. Status-only updates do not reset the user's local selection.

Only two state fields change this fixed lesson: `data.step` (zero-based frame)
and `data.show_harmony` (boolean). The renderer's reply/status area reflects the
service-owned envelope; do not fabricate completion. To highlight another step,
a permitted **main** reads `widget_read`, then uses the returned current revision
with `widget_update({id,expected_revision,state})`, where `state` is a JSON-object
string such as `{"step":2,"show_harmony":true}`. Preserve the source private
chat/topic. Workers can return widgets but cannot read/update them through these
main-only tools; read-only mains may read but cannot update, and internal
reviewers have neither tool. Never bypass those role limits with code.

HTML is immutable after sending. A new melody, explanation or arrangement needs
a new widget/result and corresponding audio/MIDI; sending new notes inside state
does not replace the diagram. Queued requests/state edits are not delivery proof.

## Validate before returning

- Keep a short phrase: 1–8 notes per monophonic voice, up to eight lesson frames,
  two offered requests and four audio/MIDI attachments. Use separate lessons for
  larger analyses rather than hiding a whole song in a cramped widget.
- The renderer checks 32768 raw UTF-8 bytes, 4096 zlib level-9 bytes and a readable
  caption within 1024 UTF-16 units. It refuses existing output directories.
- Render and inspect at 320 px width in light and dark themes. Try Next/Back,
  harmony toggling and every offered request with a test bridge. Check text,
  note spelling, time labels, no horizontal/internal scrolling and height below
  560 px. No external resources, form/keyboard inputs or audio/video elements.
- `en`/`ru` select UI labels; lesson prose is supplied in the JSON. Update both
  the caption and frame explanations in the user's language. Keep estimated,
  proposed and synthetic labels accurate rather than treating visuals as proof.
- A browser bridge simulation and service validation prove local behavior only.
  Telegram API acceptance, device rendering, actual callbacks and musician
  acceptance need separate evidence. Use native rich/text fallback for groups.

Repository checks (no Telegram messages or model calls):

```sh
python3 -m unittest discover -s test -p 'music_widgets.py'
node --test test/music-widgets.test.js
MUSIC_WIDGET_BROWSER=1 node --test test/music-widgets.test.js
```

The last command needs the repository's Playwright Chromium installation;
`BROWSER_EXECUTABLE` can select an existing compatible Chromium binary. Set
`MUSIC_WIDGET_ARTIFACTS` to a private directory to retain phone screenshots.
The browser check exercises both themes, Russian labels, missing/partial bridge
methods, request failures, stale revisions and completion/acceptance races.
