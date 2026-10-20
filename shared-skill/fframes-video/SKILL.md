---
name: fframes-video
description: Create and review programmatic videos, motion graphics, animated charts, explainers and social clips with FFrames Rust/SVG and the CPU renderer. Use for requested video artifacts or FFrames changes, not ordinary chat or research.
---

# CPU video production

Use the installed FFrames 1.2.0 generator and CPU renderer. Rust 1.98.0 and
native codec/build dependencies are installed. This installation's `cargo fframes
new` wrapper selects CPU automatically and rejects GPU backends. Always pass
`--backend cpu --yes` explicitly in reusable commands. Do not install Skia,
Vulkan, GPU shaders, a window server, browser editor or another rendering service.
CPU rendering is headless; the native `preview` window is unavailable.

Read [design](references/design.md) before designing a clip,
[API](references/api.md) while coding and [audio](references/audio.md) when sound
is needed. These upstream references also describe GPU features; use only the
CPU-compatible parts and the installed version's actual `--help`/compiler API.

## Workspace and execution

In containers, keep projects under `/workspace/projects/` and deliverables under
`/workspace/outputs/`. Cargo's default cache under `$HOME/.cargo` is writable and
persistent. Do not put builds or media in the small ephemeral `/tmp` filesystem.
Keep project source, media and Cargo.lock so the owner can revise the video.

On a laptop use an owner-selected project/output directory. Rustup installations
should invoke `cargo +1.98.0` for builds; keep the existing default toolchain.
Containers ship direct Rust 1.98 binaries and use plain `cargo`.
Login shells can reset PATH. If a container terminal cannot find Cargo, use its
non-login mode or prepend `/opt/fframes/bin:/opt/fframes/rust/bin` to PATH for the
command. The toolchain is installed; do not reinstall it to repair a shell PATH.

Use the existing worker workflow for long video tasks and render one clip at a
time per instance. Start with `CARGO_BUILD_JOBS=2` for compilation and
`RAYON_NUM_THREADS=2` for rendering. These are resource settings, not security or
scheduler enforcement. Preserve existing container CPU/memory limits; report an
out-of-memory or timeout failure rather than changing infrastructure yourself.

```sh
cargo fframes new my-video --backend cpu --format landscape --fps 30 --yes
cd my-video
mkdir -p .cargo
printf '[build]\njobs = 2\ntarget-dir = "%s"\n\n[env]\nTAR_OPTIONS = "--no-same-owner"\nFFMPEG_FORCE_BUILD = "1"\n' "$HOME/.cache/fframes/target" > .cargo/config.toml
CARGO_BUILD_JOBS=2 cargo build --release
RAYON_NUM_THREADS=2 cargo run --release -- timeline
```

Create this config only in a new project; preserve and merge any existing project
configuration. The shared per-instance target cache reuses compiled dependencies
across clips. Source and Cargo.lock stay in their own projects. On the laptop use
`cargo +1.98.0` in the build/run commands above.

The Cargo environment setting lets native archives extract without restoring
their upstream owner IDs. It is required for root containers with all capabilities
dropped. Keep it in project config because the model's environment is filtered.
Do not grant CHOWN or relax container security to install native dependencies.
Build uncached FFmpeg libraries against the installed codec libraries: upstream
Linux prebuilt archives can target a different x264 ABI. `FFMPEG_FORCE_BUILD=1`
avoids that mismatch; existing compiled target caches are still reused. An initial
source build can take many minutes, so preserve the private per-instance cache.

Use portrait for 1080x1920 social clips, landscape for 1920x1080. Keep the
generated exact FFrames version and Cargo.lock. Use the `build-portable` FFrames
feature when source-built FFmpeg artifacts will run on another CPU.

## Create and inspect

Clarify duration, aspect ratio, audience and essential content only when they
materially affect the requested result. Make reasonable reversible design choices.
FFrames renders agent-written Rust/SVG; any source footage, music, voice or images
must be available or separately authorized. Do not invent an installed provider.

Replace template placeholders with a deliberate design. Use a few colors, readable
type, sufficient margins and clear pacing. Embed every required font/image/audio
under the project's media directory. Prepare data outside `render_frame` and
avoid per-frame I/O or heavy computation. Keep animation CPU-compatible; moving
blur/shadow filters can be expensive.

Run commands with `cargo run --release --` (or `cargo +1.98.0 run --release --`
on the laptop). `--json` makes supported command output easier to parse.

1. `timeline`: verify scenes, duration and audio cues.
2. `inspect --fail-on warning`: check missing assets/glyphs, invalid SVG, canvas
   overflow and panics. Fix errors; review intentional entrance/exit warnings.
3. `strip -n 12`: render a contact sheet and actually open the PNG.
4. `frame 1s,50%,end`: inspect key frames at full resolution when needed.
5. `audio analyze`: check loudness/clipping when the clip contains audio.
6. `render --draft`: review a quick draft when useful, then `render -o out.mp4`.

First compilation downloads native libraries and Rust dependencies and may be
much slower than subsequent builds. Record compilation and rendering separately
when measuring performance. Never present GPU marketing benchmarks as CPU results.

## Verify and deliver

Use `ffprobe` to verify actual duration, 1920x1080 or the requested dimensions,
frame count/rate, codec and expected audio. Inspect the contact sheet before
claiming the visual result is correct. Snapshot baselines require visual review.

Return the MP4 and optional contact sheet through the existing structured `files`
array, with absolute workspace paths. Keep each outgoing file below the service's
49 MiB limit; use a suitable H.264 bitrate/CRF or ask about an authorized alternate
delivery for larger files. MP4 is currently delivered as a Telegram document.
Queued output is not confirmed delivery. Retain the source project for revisions.
