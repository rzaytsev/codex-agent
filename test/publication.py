from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class PublicationTests(unittest.TestCase):
    def test_private_force_add_and_index_secret_cannot_hide_behind_clean_worktree(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'scripts').mkdir()
            checker = root / 'scripts/check-publication.py'
            shutil.copyfile(Path(__file__).parents[1] / 'scripts/check-publication.py', checker)
            def git(*args):
                return subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True)
            def check(*args):
                return subprocess.run(['python3', str(checker), *args], capture_output=True, text=True)
            git('init', '-q')
            (root / '.gitignore').write_text('private/\n')
            hidden = root / 'private/instances/demo/agent.env'
            hidden.parent.mkdir(parents=True)
            hidden.write_text('synthetic secret\n')
            self.assertEqual(check().returncode, 0)
            git('add', '-f', str(hidden))
            self.assertNotEqual(check('--staged').returncode, 0)
            git('rm', '--cached', '-f', str(hidden))
            candidate = root / 'example.txt'
            token = '123456789:' + 'a' * 35
            candidate.write_text(token)
            git('add', 'example.txt')
            candidate.write_text('scrubbed working copy')
            result = check('--staged')
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(token, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
