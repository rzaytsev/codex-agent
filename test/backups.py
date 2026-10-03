import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('backups', Path(__file__).parents[1] / 'scripts/backup-agents.py')
backups = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backups)
acl_spec = importlib.util.spec_from_file_location('source_acls', Path(__file__).parents[1] / 'scripts/prepare-source-access.py')
source_acls = importlib.util.module_from_spec(acl_spec)
acl_spec.loader.exec_module(source_acls)


class BackupTests(unittest.TestCase):
    def test_conversation_databases_receive_separate_consistent_snapshots(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace, state = root / 'workspace', root / 'snapshots'
            identity = '00000000-0000-4000-8000-000000000001'
            group = workspace / 'state/conversations' / identity
            group.mkdir(parents=True)
            state.mkdir()
            with sqlite3.connect(workspace / 'state/assistant.sqlite') as catalog:
                catalog.execute('CREATE TABLE conversations(id TEXT, kind TEXT)')
                catalog.execute('INSERT INTO conversations VALUES (?,?)', (identity, 'group'))
            with sqlite3.connect(group / 'assistant.sqlite') as database:
                database.execute('PRAGMA journal_mode=WAL')
                database.execute('CREATE TABLE evidence(value TEXT)')
                database.execute("INSERT INTO evidence VALUES ('group fact')")
            records = backups.database_snapshots(workspace, state)
            self.assertEqual(len(records), 2)
            self.assertEqual(records[1]['destination'], str(group / 'assistant.sqlite'))
            with sqlite3.connect(records[1]['snapshot']) as snapshot:
                self.assertEqual(snapshot.execute('SELECT value FROM evidence').fetchone()[0], 'group fact')
            (group / 'assistant.sqlite').unlink()
            with self.assertRaises(RuntimeError):
                backups.database_snapshots(workspace, state)

    def test_private_settings_and_complete_instance_directory_are_selected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            instance = root / 'private/instances/demo'
            (instance / 'seed').mkdir(parents=True)
            (instance / 'agent.env').write_text('TELEGRAM_BOT_TOKEN=\n')
            settings = {key: str(root / key) for key in ('source', 'backup_root', 'state_root', 'password_root', 'restic')}
            settings['instances'] = ['demo']
            file = root / 'backups.json'
            file.write_text(json.dumps(settings))
            self.assertEqual(backups.read_settings(file), settings)
            self.assertEqual(backups.instance_files(root, 'demo'), [instance, root / 'compose.yaml'])
            with self.assertRaises(RuntimeError):
                backups.instance_files(root, 'absent')
            for names in [[], ['demo', 'demo'], ['../escape']]:
                settings['instances'] = names
                file.write_text(json.dumps(settings))
                with self.assertRaises(RuntimeError):
                    backups.read_settings(file)

    def test_online_wal_snapshot_excludes_uncommitted_work(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            db = sqlite3.connect(root / 'live.sqlite')
            self.addCleanup(db.close)
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE evidence(value TEXT)')
            db.execute("INSERT INTO evidence VALUES ('committed')")
            db.commit()
            db.execute("INSERT INTO evidence VALUES ('uncommitted')")
            backups.sqlite_snapshot(root / 'live.sqlite', root / 'snapshot.sqlite')
            copy = sqlite3.connect(root / 'snapshot.sqlite')
            self.addCleanup(copy.close)
            self.assertEqual(copy.execute('SELECT value FROM evidence').fetchall(), [('committed',)])
            db.rollback()

    def test_mount_inventory_deduplicates_nested_roots_and_skips_tmpfs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'state').mkdir()
            mounts = [dict(Type='bind', Source=str(root), Destination='/workspace', RW=True),
                      dict(Type='bind', Source=str(root / 'state'), Destination='/nested', RW=False),
                      dict(Type='tmpfs', Source='', Destination='/tmp', RW=True)]
            roots, workspace, inventory = backups.mount_sources(dict(Mounts=mounts))
            self.assertEqual(roots, [str(root)])
            self.assertEqual(workspace, root)
            self.assertEqual(len(inventory), 2)

    def test_repository_overlap_and_missing_sources_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'repos').mkdir()
            original = backups.BACKUPS
            backups.BACKUPS = root / 'repos'
            self.addCleanup(setattr, backups, 'BACKUPS', original)
            for source in [root, root / 'repos', root / 'missing']:
                with self.subTest(source=source), self.assertRaises(RuntimeError):
                    backups.mount_sources(dict(Mounts=[dict(Type='bind', Source=str(source), Destination='/workspace', RW=True)]))

    def test_missing_workspace_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(RuntimeError):
                backups.mount_sources(dict(Mounts=[dict(Type='bind', Source=root, Destination='/other', RW=True)]))

    def test_private_config_cannot_recursively_back_up_its_repository(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'private/instances/demo'
            directory.mkdir(parents=True)
            original = backups.BACKUPS
            backups.BACKUPS = directory / 'repository'
            self.addCleanup(setattr, backups, 'BACKUPS', original)
            with self.assertRaises(RuntimeError):
                backups.reject_repository_overlap([directory])

    def test_source_acl_grant_preserves_other_effective_permissions(self):
        with tempfile.TemporaryDirectory() as root:
            block = f'# file: {root}\n# owner: 501\n# group: 50\nuser::rwx\nuser:1001:rwx\ngroup::---\nmask::---\nother::---\ndefault:user::rwx\ndefault:group::---\ndefault:other::---\n'
            changed = source_acls.grant(block)
            self.assertIn('user:0:r-x', changed)
            self.assertIn('user:1001:---', changed)
            self.assertIn('mask::r-x', changed)
            self.assertIn('default:user::rwx', changed)
            self.assertIsNone(source_acls.grant(changed))

    def test_source_acl_grant_preserves_root_owned_private_file(self):
        block = '# file: /file\n# owner: 0\n# group: 0\nuser::rw-\ngroup::---\nother::---\n'
        self.assertIsNone(source_acls.grant(block))

    def test_shared_skill_wrapper_requires_snapshot_and_delegates_without_broadening_scope(self):
        repository = Path(__file__).parents[1].resolve()
        wrapper = repository / 'scripts/prepare-shared-skills.sh'
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            stub = directory / 'python3'
            stub.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            stub.chmod(0o700)
            env = {**os.environ, 'PATH': str(directory) + os.pathsep + os.environ['PATH']}
            for arguments in [[], ['--snapshot-dir'], ['--wrong', str(directory)]]:
                result = subprocess.run(['sh', str(wrapper), *arguments], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, '')
            snapshot = directory / 'private snapshot'
            result = subprocess.run(['sh', str(wrapper), '--snapshot-dir', str(snapshot)],
                                    cwd=directory, env=env, capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout.splitlines(), [str(repository / 'scripts/prepare-source-access.py'),
                                                         '--snapshot-dir', str(snapshot), str(repository / 'shared-skill')])


if __name__ == '__main__':
    unittest.main()
