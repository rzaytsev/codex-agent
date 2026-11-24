# Optional music toolchain deployment

The [music-assistant skill](../shared-skill/music-assistant/SKILL.md) works as a
portable standalone skill or an optional tooling layer on a validated assistant
image. `Dockerfile.music` preserves that image's application code except for the
reviewed voice-note-only `src/media.js` intake change. Do not ship unrelated
checkout changes when selecting an existing base image.

The layer requires Debian Bookworm / Python 3.11, installs SoX and Rubber Band,
and supplies `/opt/music/bin/python` with pinned analysis libraries, CPU ONNX,
Essentia and CPU-only PyTorch/Demucs. The `htdemucs` weights are downloaded while
building, so normal default-model separation works with a read-only root and
does not download weights into the instance. Models/packages stay image-owned;
generated files and writable caches stay in the instance workspace.

```sh
docker build -f Dockerfile.music \
  --build-arg ASSISTANT_BASE_IMAGE=assistant:validated-base \
  -t assistant:music .
```

Build from each selected instance's actual base when their images differ. Retain
its image digest, selected private Compose override and consistent database/profile
backup. First test the candidate without a bot token, live workspace or Codex
mount; never start a second poller. Run the synthetic media tests, ten music tests,
MP3 inference and cached model separation with the existing CPU/memory/read-only
constraints. Confirm every application source hash except the intended intake
file, plus package/dependency hashes, matches the base.

In the selected private override, retain existing settings and add:

```yaml
services:
  assistant:
    image: assistant:music
    volumes:
      - ./shared-skill/music-assistant:/workspace/.agents/skills/music-assistant:ro
```

Resolve the source path against the launcher's actual project directory. Prepare
read/search permissions for this public skill using the documented source-access
helper where required; retain its ACL snapshot. Do not relax instance security
or replace existing private mounts. The general shared-skills inventory still
describes the default mounts; this selected optional mount needs its own discovery
assertion alongside that smoke.

While each instance is idle, append the exact [music capability section](../templates/MUSIC.md)
once to its workspace AGENTS.md, preserving all existing custom content. This is
an explicit operator rollout step: the existing initializer does not automatically
distribute a new optional section. Save the previous file and verify its bytes
are an unchanged prefix. USER.md and SOUL.md are not replaced.

Validate quietly with `bin/agent config NAME`, then recreate one instance at a
time with `bin/agent up NAME --no-build --force-recreate`. Verify ready health,
unchanged persistence mounts, security/resource settings, existing authentication,
durable state and enabled native discovery at the music skill's exact path. Run
`music doctor` and a bounded synthetic/reference smoke in that instance. Preserve
rollback images/config and reconcile work before any rollback; do not blindly
restore a stale database or replay external actions.

## Runtime use and intake

`music` selects the isolated Python and writable per-instance cache paths.
`music analyze`, `features`, `reference`, `harmonize` and `shift` use the helper;
`music separate --two-stems vocals -o NEW_DIRECTORY FILE` invokes cached CPU
Demucs. Alternative separation models are not preloaded. Sonic Annotator remains
an optional alternative and is not installed by this layer.

Automatic speech transcription uses Telegram's voice-note message type. All
other recognized audio uploads/documents retain original paths and get a music
workflow hint. An Opus file sent as a regular document is not a voice command.
Forwarded captions/lyrics/transcripts remain source data. With an explicit owner
request or clear context, the model proceeds; otherwise it should ask what the
owner wants before doing analysis. This conversational choice requires separate
real-task acceptance. The hosted Telegram download cap remains 20 MiB.

Container checks do not establish musical accuracy, model adherence or actual
Telegram delivery. Keep private deployment receipts and generated artifacts out
of the reusable skill source.

## Graphical music explanations

HTML widget delivery, offered requests and live state are disabled. Use the
current [ImageGen presentation guidance](telegram-presentations.md) for ordinary
PNG/JPEG explanations of melody, intervals, scale degrees, chord tones and
proposed harmony. Check the generated note names, timing and evidence labels.
WAV/MIDI listening guides remain separate artifacts.

The five older lesson templates and their standard-library renderer are retained
for historical/local work only. Their contract/browser tests do not establish
production widget availability. The dependency-free theory tests run on the
host; run all `music_assistant.py` checks in the optional Python 3.11 environment
before claiming audio validation.
