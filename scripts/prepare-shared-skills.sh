#!/bin/sh
set -eu
# Public skills need read/search access only. Preserve other effective rights and a rollback snapshot.
[ "$#" -eq 2 ] && [ "$1" = --snapshot-dir ] || { echo 'Usage: scripts/prepare-shared-skills.sh --snapshot-dir PRIVATE_DIRECTORY' >&2; exit 2; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec python3 "$root/scripts/prepare-source-access.py" --snapshot-dir "$2" "$root/shared-skill"
