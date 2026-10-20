#!/usr/bin/env python3
"""Run a synthetic 15 s / 1080p / 30 fps CPU benchmark in a fresh directory."""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path)
parser.add_argument("--toolchain", help="Optional installed rustup toolchain, for laptop builds")
args = parser.parse_args()
directory = args.directory.resolve()
if directory.exists():
    parser.error("Use a new directory so existing video projects are preserved.")
cargo = ["cargo", *([f"+{args.toolchain}"] if args.toolchain else [])]
subprocess.run([*cargo, "fframes", "new", "fframes-benchmark", "--backend", "cpu", "--format", "landscape", "--fps", "30", "--yes", "--dir", str(directory)], check=True)
source = Path(__file__).resolve().parent.parent / "examples" / "fframes-benchmark.rs"
shutil.copyfile(source, directory / "src/main.rs")
env = {**os.environ, "CARGO_BUILD_JOBS": "2", "RAYON_NUM_THREADS": "2", "CARGO_TARGET_DIR": str(directory / "target"), "TAR_OPTIONS": "--no-same-owner", "FFMPEG_FORCE_BUILD": "1"}
receipt = {"backend": "cpu", "fframes": "1.2.0", "width": 1920, "height": 1080, "fps": 30, "seconds": 15, "threads": 2, "audio": False, "platform": platform.platform(), "stages": {}}


def measured(name, command):
    log = directory / f"{name}.log"
    resources = directory / f"{name}-resources.txt"
    if platform.system() == "Darwin":
        timed = ["/usr/bin/time", "-l", *command]
    else:
        timed = ["/usr/bin/time", "-v", "-o", str(resources), *command]
    started = time.monotonic()
    with log.open("w") as output:
        result = subprocess.run(timed, cwd=directory, env=env, stdout=output, stderr=subprocess.STDOUT)
    elapsed = time.monotonic() - started
    text = (log if platform.system() == "Darwin" else resources).read_text()
    match = re.search(r"(\d+)\s+maximum resident set size", text) if platform.system() == "Darwin" else re.search(r"Maximum resident set size \(kbytes\): (\d+)", text)
    rss = int(match[1]) / (1024 ** 2 if platform.system() == "Darwin" else 1024) if match else None
    receipt["stages"][name] = {"wall_seconds": round(elapsed, 3), "peak_rss_mib": round(rss, 1) if rss else None, "exit_code": result.returncode}
    (directory / "benchmark.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"stage": name, **receipt["stages"][name]}), flush=True)
    if result.returncode:
        raise SystemExit(f"{name} failed; inspect {log}")


measured("initial-build", [*cargo, "build", "--release"])
measured("warm-build", [*cargo, "build", "--release", "--locked"])
binary = str(directory / "target/release/fframes-benchmark")
measured("inspect", [binary, "inspect", "--fail-on", "warning"])
measured("strip", [binary, "strip", "-n", "12"])
measured("render", [binary, "render", "-o", "out.mp4"])
probe = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_read_frames,codec_name:format=duration,size", "-of", "json", str(directory / "out.mp4")], check=True, capture_output=True, text=True)
receipt["probe"] = json.loads(probe.stdout)
stream = receipt["probe"]["streams"][0]
receipt["verified"] = stream["width"] == 1920 and stream["height"] == 1080 and stream["r_frame_rate"] == "30/1" and stream["nb_read_frames"] == "450" and abs(float(receipt["probe"]["format"]["duration"]) - 15) < 0.01
receipt["render_fps"] = round(450 / receipt["stages"]["render"]["wall_seconds"], 2)
(directory / "benchmark.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt, indent=2))
if not receipt["verified"]:
    raise SystemExit("Benchmark video metadata did not match the requested output.")
