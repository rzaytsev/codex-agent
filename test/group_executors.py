import importlib.util
from pathlib import Path
import tempfile
import unittest
import uuid

spec = importlib.util.spec_from_file_location('group_broker', Path(__file__).parents[1] / 'scripts/group-executor-broker.py')
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


class ExecutorBoundary(unittest.TestCase):
    def test_only_one_canonical_group_is_mounted_without_credentials_or_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            identity = str(uuid.uuid4())
            group = root / 'conversations' / identity
            for folder in ('outputs', 'projects', 'tasks'):
                (group / folder).mkdir(parents=True)
            instance = {'workspace': temporary, 'image': 'synthetic:1'}
            _, command = broker.executor_command(instance, {'conversation': identity, 'writable': True})
            self.assertIn('--network', command)
            self.assertEqual(command[command.index('--network')+1], 'none')
            self.assertIn('--cap-drop=ALL', command)
            self.assertIn('--security-opt=no-new-privileges:true', command)
            mounts = [command[i+1] for i, value in enumerate(command) if value == '--mount']
            self.assertEqual(len(mounts), 4)
            self.assertTrue(all(f'src={group}' in value for value in mounts))
            self.assertFalse(any('auth' in value or 'docker.sock' in value for value in mounts))
            _, readonly = broker.executor_command(instance, {'conversation': identity, 'writable': False})
            self.assertEqual(readonly.count('--mount'), 1)
            (group/'outputs').rmdir()
            (group/'outputs').symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError):
                broker.executor_command(instance, {'conversation': identity, 'writable': True})

    def test_request_cannot_choose_host_path_image_or_privileges(self):
        instance = {'workspace': '/tmp', 'image': 'synthetic:1'}
        for request in ({'conversation':'../../private','writable':True},
                        {'conversation':str(uuid.uuid4()),'writable':True,'image':'other'},
                        {'conversation':str(uuid.uuid4()),'writable':'true'}):
            with self.assertRaises(ValueError):
                broker.executor_command(instance, request)
