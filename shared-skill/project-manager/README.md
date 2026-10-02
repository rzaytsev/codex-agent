# Project Manager Skill

A self-contained skill for managing software, app, and game projects from an agreed vision through small milestones, implementation handoffs, testing of exact builds, and fix-and-retest loops. It keeps progress, decisions, screenshots, and versioned QA evidence in the requested private project Space.

## Install and use

1. Download [SKILL.md](SKILL.md).
2. Upload it to ChatGPT and ask: **“Please install this skill as project-manager.”**
3. Invoke it with **@project-manager** and describe the project, intended outcome, existing implementation thread, and project Space.

Example: “@project-manager Manage this app through the agreed milestones. Use my existing implementation thread, test each exact build, and keep the project Space current.”

## Prerequisites and limitations

- Skill installation and invocation depend on support in your ChatGPT environment.
- Execution requires connected, authorized tools for the repository, implementation thread, build/runtime, and testing. Screenshot capture, artifact transfer, and durable evidence storage require corresponding capabilities.
- Maintaining a project Space requires access to that Space and supported editing tools. Separate QA workers are used when available; otherwise, a separately reported testing pass is required.
- The skill supplies a workflow, not tools, credentials, permissions, or unattended execution. Missing capabilities and untested criteria must be reported explicitly.
- Public publication, production deployment, merging, spending, account changes, and broader sharing need their own authorization.

The complete workflow is in `SKILL.md`; no companion scripts are required.
