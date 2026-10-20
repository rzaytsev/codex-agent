import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class CpuGeneratorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.wrapper = root / "cargo-fframes"
        shutil.copyfile("scripts/cargo-fframes.py", self.wrapper)
        self.wrapper.chmod(0o755)
        generator = root / "cargo-fframes.real"
        generator.write_text("#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n")
        generator.chmod(0o755)

    def run_generator(self, *args):
        return subprocess.run([self.wrapper, *args], capture_output=True, text=True)

    def test_cargo_invocation_defaults_to_cpu_and_preserves_arguments(self):
        result = self.run_generator("fframes", "new", "a-video", "--dir", "path with spaces", "--yes")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), ["new", "a-video", "--dir", "path with spaces", "--yes", "--backend", "cpu"])

    def test_explicit_cpu_and_help_pass_through(self):
        for args in [("new", "a-video", "--backend=cpu"), ("new", "a-video", "--backend", "cpu"), ("--help",)]:
            with self.subTest(args=args):
                result = self.run_generator(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), list(args))

    def test_gpu_is_rejected_before_generation(self):
        result = self.run_generator("new", "a-video", "--backend", "skia-vulkan")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("--backend cpu", result.stderr)
