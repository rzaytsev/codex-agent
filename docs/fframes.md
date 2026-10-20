# CPU video tooling

The image includes Rust 1.98.0, cargo-fframes 1.2.0 and the native codec/build
dependencies for FFrames' CPU renderer. The read-only `fframes-video` skill
covers programmatic motion graphics, explainers and animated charts. It does not
add a Telegram command, model provider, GPU grant or separate rendering service.

`templates/FFRAMES.md` supplies a `CPU video tooling v1` section explaining that
the installed CLI runs through terminal tools; searching only for video-named
MCP tools does not test this capability. Startup appends that section once to
new and existing workspaces, preserving custom instructions. Updating the
initializer requires an authorized image rollout; an operator can append the
same section once to existing workspaces without an application upgrade.
The agent reads workspace instructions for each turn, so an applied guidance
update requires no restart or session reset.
Skill discovery alone does not prove that a model will choose it correctly.

`cargo fframes new` uses a small wrapper which defaults to `--backend cpu` and
rejects GPU backends. Explicit CPU commands are portable to upstream installs:

```sh
cargo fframes new my-video --backend cpu --format landscape --fps 30 --yes
cd my-video
mkdir -p .cargo
printf '[build]\njobs = 2\ntarget-dir = "%s"\n\n[env]\nTAR_OPTIONS = "--no-same-owner"\nFFMPEG_FORCE_BUILD = "1"\n' "$HOME/.cache/fframes/target" > .cargo/config.toml
CARGO_BUILD_JOBS=2 cargo build --release
RAYON_NUM_THREADS=2 cargo run --release -- inspect --fail-on warning
RAYON_NUM_THREADS=2 cargo run --release -- strip -n 12
RAYON_NUM_THREADS=2 cargo run --release -- render -o out.mp4
```

Use `/workspace/projects/` for source and `/workspace/outputs/` for deliverables.
The default Cargo cache under `$HOME/.cargo` persists in the existing workspace.
The new-project configuration above also reuses compiled dependencies across
clips through `$HOME/.cache/fframes/target`; merge existing config rather than
overwriting it. This cache is private to each instance.
The Cargo environment setting is needed for native archive extraction under
`cap_drop: ALL`: upstream FFmpeg archives contain a build-machine UID, and
restoring it would require CHOWN. Keep `--no-same-owner` in project config for
filtered model subprocesses; the image and benchmark also set it for direct
commands. Do not broaden container capabilities to make archive extraction work.
Uncached FFmpeg builds use the source build (`FFMPEG_FORCE_BUILD=1`) to match
the image's installed codec ABI. The upstream Linux prebuilt x264 archive can
expect ABI 163 while Debian Bookworm provides ABI 164. A compiled target cache
still skips native rebuilding. Keep that cache private to the instance and build
host; native fallback output can contain CPU-specific instructions.
Do not build in the small `/tmp` tmpfs or write to the image-owned toolchain.
Rust binaries are copied from the pinned official Rust image into a standalone
sysroot, so agent subprocesses need no additional environment forwarding or
rustup access. Project source, media and Cargo.lock should be retained.

If a login shell resets PATH, use the terminal tool's non-login mode or prepend
`/opt/fframes/bin:/opt/fframes/rust/bin` for container commands. A missing command
in that shell does not require reinstalling the toolchain.

The ordinary image build includes these tools. For an operator-authorized tooling
update to an already validated application image, the same Dockerfile supports:

```sh
docker build --target fframes-runtime \
  --build-arg ASSISTANT_BASE_IMAGE=assistant:validated-base \
  -t assistant:cpu-video .
```

This target retains the supplied image's application code/entrypoint and adds the
FFrames toolchain, benchmark helper and skill-discovery inventory. Keep the base
image/Compose configuration for rollback, add the skill's read-only mount, then
recreate each idle instance with its selected image. Preserve all existing
workspace/Codex/source/seed mounts, security settings and resource limits. Confirm
that the base image already supports the other inventory skills before using
this target. Existing personal profiles are not replaced.

## Benchmark and acceptance

Run the same synthetic chart/motion workload in a fresh persistent directory:

```sh
python3 scripts/fframes-benchmark.py /workspace/outputs/fframes-benchmark-UNIQUE
```

It creates a CPU project, uses two build/render threads, records initial and warm
release builds separately, checks layout, creates a contact sheet, renders H.264
with CRF 20 / medium / animation, and verifies 1920x1080, 30 fps, 450 frames and
15 seconds with ffprobe. The workload has no audio; it does not establish audio
mixing performance. Logs and `benchmark.json` retain wall time and the timed
process's maximum RSS (not the entire container's peak memory). Cold dependency
downloads affect the initial build. A failed native archive extraction can
otherwise trigger a long FFmpeg source build; the ownership setting above avoids
the dropped-capability failure without broadening permissions. A new project does not imply an empty global
Cargo cache. Open the contact sheet to verify visual output.

The helper requires GNU time in Linux images and uses BSD time on macOS. Laptop
rustup installs should add `--toolchain 1.98.0`, preserving their default toolchain.
Install the generator with `cargo +1.98.0 install --locked --version 1.2.0
cargo-fframes`, native dependencies from upstream, and the CPU wrapper beside a
retained `cargo-fframes.real`. Install the skill under `.agents/skills/fframes-video`.

Run the shared-skills discovery smoke for each instance. Actual rendering proves
the native toolchain; health latency measured during a render proves only that
endpoint's responsiveness. Model routing, conversational responsiveness and real
Telegram video delivery require separate owner acceptance. MP4 currently uses
document delivery, with the existing 49 MiB outgoing file limit.

Sources: [FFrames](https://github.com/dmtrKovalenko/fframes),
[CPU renderer](https://docs.rs/fframes/latest/fframes/struct.CpuRenderingBackend.html).
