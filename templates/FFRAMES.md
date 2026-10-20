## CPU video tooling v1

FFrames and its CPU renderer are installed. For requested video artifacts, read
`.agents/skills/fframes-video/SKILL.md` and use the existing terminal tools to
create, render and inspect a Rust/SVG video. This is a local CLI capability;
absence of a video-named MCP tool or search result does not mean video creation
is unavailable. Check `cargo --version` and `cargo fframes --help` before claiming
the installation is missing. Distinguish programmatic motion graphics from an
external AI footage generator, which requires a separately configured provider.

Main turns should delegate substantial video production through `create_task`
with the skill path, requested content, duration, format and output directory.
Workers follow the skill and return the verified MP4 through `files`. Read-only
and internal review turns must not generate artifacts or bypass denied tools.
