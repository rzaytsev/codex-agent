# Privacy and publication

The public repository contains reusable code, generic templates, tests, examples
and documentation. The whole `private/` directory is excluded from Git and Docker
build contexts. Authentication, conversations, profiles, locations, attachments,
generated artifacts and learned skills belong in external runtime directories.

## Boundaries

- `private/instances/NAME`: env credentials, instance overrides, seeds and imports.
- `private/shared-skills`: optional personal or mutable shared skills.
- `private/operations`: host settings, deployment history, migration archives,
  private audit findings and the optional publication denylist.
- Public skills are mounted read-only. Review and sanitize private work before
  deliberately promoting it into source.
- Only the selected seed directory and explicitly configured source/skill mounts
  enter a container. Never mount the entire private directory or host Docker socket.
- Git ignore rules do not remove files already tracked, prevent force-add, encrypt
  data, or govern source-sync software. Review sync permissions separately.
- Docker ignore rules exclude private files before sending the build context.
  Dockerfile uses explicit COPY inputs; never add secrets via COPY, ARG or ENV.

## Before a first commit or publication

Initialize a fresh repository only after separating personal files. Inspect the
actual candidate tree, including filenames, docs, fixtures, imported skills,
URLs, generated logs and commit identity. Real names, bot handles, hostnames,
company details and screenshots can leak without resembling credentials.

```sh
python3 scripts/check-publication.py
```

This checks tracked and nonignored untracked files without printing matched
values. An optional private/operations/publication-denylist.txt adds one private
literal per line; keep this list out of public CI. After staging intended files,
run `python3 scripts/check-publication.py --staged` to inspect index bytes. The
checker rejects private paths even when force-added; it complements manual review
and a redacted secret scanner, rather than proving no private information exists.

Scan a clean export of the exact publication candidates with a secret scanner.
Do not scan or upload the entire private workspace to an external service.
If importing an existing repository, review reachable history, tags and commit
metadata too; adding .gitignore does not sanitize old commits. If a credential
was exposed, revoke/rotate it before treating history cleanup as sufficient.

Use a suitable Git author identity (for example a GitHub noreply address) if your
personal email should remain private. Inspect the staged diff before committing.
No script here commits, pushes, creates GitHub repositories or publishes images.

## Recovery and redistribution

Ignored configuration still needs a protected backup. Preserve original private
source/config archives during migration until restart and restore are accepted.
Runtime data and protected Codex authentication must never be replaced by a fresh
clone. See [backups](backups.md).

Keep supplied third-party notices and ORIGIN.md files intact. Imported skills
without an explicit redistribution license need a license review before public
release. The project currently declares no project-wide license. Initializing
Git does not grant new rights or publish any content.
