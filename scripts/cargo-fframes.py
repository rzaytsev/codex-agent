#!/usr/bin/env python3
"""Keep the installed FFrames project generator on the CPU backend."""
import os
from pathlib import Path
import sys

args = sys.argv[1:]
if args[:1] == ["fframes"]:  # cargo passes its subcommand name to the executable.
    args = args[1:]
if args[:1] == ["new"]:
    backend = None
    for index, arg in enumerate(args):
        if arg == "--backend":
            backend = args[index + 1] if index + 1 < len(args) else ""
        elif arg.startswith("--backend="):
            backend = arg.split("=", 1)[1]
    if backend is None:
        args += ["--backend", "cpu"]
    elif backend != "cpu":
        sys.exit("This FFrames installation uses --backend cpu; GPU backends are not configured.")

generator = Path(__file__).resolve().with_name("cargo-fframes.real")
os.execv(generator, [str(generator), *args])
