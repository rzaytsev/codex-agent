#!/usr/bin/env python3
"""Run the bundled tdl with one persisted owner session and an exclusive lock."""
import fcntl
import json
import os
import signal
from pathlib import Path
import subprocess
import sys


def main(args=None, binary="/usr/local/libexec/tdl"):
    args = sys.argv[1:] if args is None else args
    if any(arg.split("=", 1)[0] in {"--ns", "--storage", "--debug"} or
           (arg.startswith("-n") and not arg.startswith("--")) for arg in args):
        print("tdl namespace, storage and debug settings are managed by this instance.", file=sys.stderr)
        return 1
    os.umask(0o077)
    home = Path(os.environ.get("WORKSPACE_DIR", "/workspace")) / "state" / "tdl"
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    if home.is_symlink() or (home / ".tdl").is_symlink():
        raise RuntimeError("tdl session directory must not be a symlink")
    home.chmod(0o700)
    with os.fdopen(os.open(home / "session.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("tdl is busy in this instance; retry after the current operation finishes.", file=sys.stderr)
            return 1
        env = {key: os.environ[key] for key in ("PATH", "LANG", "TERM") if key in os.environ}
        env.update(HOME=str(home), TDL_NS="owner", TDL_DEBUG="false",
                   TDL_STORAGE=json.dumps({"type": "bolt", "path": str(home / ".tdl" / "data")}))
        child = subprocess.Popen([binary, *args], env=env)
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
        def relay(signum, _frame):
            if child.poll() is None:
                child.send_signal(signum)
        for sig in previous:
            signal.signal(sig, relay)
        try:
            return child.wait()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError):
        print("tdl could not start; check the installed binary and session-directory permissions. Private details suppressed.", file=sys.stderr)
        raise SystemExit(1)
