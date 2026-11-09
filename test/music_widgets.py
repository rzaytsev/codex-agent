"""Music widget data/format checks using synthetic lessons and no audio models."""
import copy
import importlib.util
import json
from pathlib import Path
import random
import string
import subprocess
import sys
import tempfile
import unittest
import wave
import zlib

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'shared-skill/music-assistant/scripts/widget.py'
SPEC = importlib.util.spec_from_file_location('music_widgets', SCRIPT)
widget = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(widget)


def lesson(name):
    return json.loads((widget.ROOT / 'templates' / (name + '.json')).read_text())


class MusicWidgetTests(unittest.TestCase):
    def test_all_lessons_fit_widget_limits_with_or_without_offered_requests(self):
        for name in widget.TYPES:
            for offered in (False, True):
                with self.subTest(name=name, offered=offered):
                    result = widget.render(lesson(name), agent_requests=offered)
                    presentation = result['presentation']
                    document = presentation['content']
                    self.assertLessEqual(len(document.encode()), 32768)
                    self.assertLessEqual(len(zlib.compress(document.encode(), 9)), 4096)
                    self.assertLessEqual(len(result['text'].encode('utf-16-le')) // 2, 1024)
                    self.assertEqual(len(presentation['actions']), int(offered))
                    self.assertEqual(json.loads(presentation['state']) if offered else presentation['state'],
                                     {'step': 0, 'show_harmony': True} if offered else None)
                    self.assertNotRegex(document, r'<(?:audio|video|iframe|input|select|form)\b')
                    self.assertNotRegex(document, r'(?:src|href)\s*=')
                    self.assertNotRegex(document, r'fetch\(|setInterval\(|setTimeout\(|localStorage|AudioContext')

    def test_markup_and_script_breakouts_are_plain_lesson_text(self):
        data = lesson('melody')
        payload = '</script><img src=x onerror=evil()>\u2028'
        data['title'] = payload
        data['notes'][0]['comment'] = payload
        result = widget.render(data)
        document = result['presentation']['content']
        self.assertEqual(document.count('<script>'), 1)
        self.assertEqual(document.count('</script>'), 1)
        self.assertNotIn('<img ', document)
        self.assertIn('&lt;/script&gt;', document)
        self.assertIn('\\u003c/script\\u003e', document)

    def test_unsupported_polyphony_and_invalid_time_are_refused(self):
        data = lesson('melody')
        data['notes'][1]['start'] = .5
        with self.assertRaisesRegex(ValueError, 'monophonic'):
            widget.render(data)
        data = lesson('melody')
        data['notes'][0]['start'] = float('nan')
        with self.assertRaisesRegex(ValueError, 'finite'):
            widget.render(data)
        with self.assertRaisesRegex(ValueError, 'monophonic analysis'):
            widget.from_analysis({'schema': 1, 'mode': 'polyphonic', 'notes': []})

    def test_incompatible_caption_and_action_metadata_are_refused(self):
        data = lesson('melody')
        data['caption'] = '😀' * 600
        with self.assertRaisesRegex(ValueError, '1024 UTF-16'):
            widget.render(data)
        data = lesson('melody')
        data['actions'].append(copy.deepcopy(data['actions'][0]))
        with self.assertRaisesRegex(ValueError, 'unique'):
            widget.render(data, agent_requests=True)
        data = lesson('melody')
        data['actions'][0]['id'] = 'not a valid id'
        with self.assertRaisesRegex(ValueError, 'ASCII'):
            widget.render(data, agent_requests=True)

    def test_larger_incompressible_lessons_fail_before_writing_outputs(self):
        data = lesson('scale')
        rng = random.Random(32)
        data['comments'] = [''.join(rng.choices(string.ascii_letters + string.digits, k=180)) for _ in range(8)]
        with self.assertRaisesRegex(ValueError, 'Telegram limits'):
            widget.render(data, agent_requests=True)

    def test_scale_spelling_follows_the_selected_tonic_and_mode(self):
        data = lesson('scale')
        data.update(tonic='Ab4', mode='minor')
        frames, _, _ = widget.lesson_frames(data, widget.UI['en'])
        source = frames[2]['svg']
        self.assertIn('Cb5', source)
        self.assertIn('Fb5', source)
        self.assertNotIn('B4', source)

    def test_analysis_adapter_preserves_estimates_and_source_offsets(self):
        data = {'schema': 1, 'mode': 'monophonic', 'excerpt': {'start_s': 30}, 'notes': [
            {'note': 'C4', 'midi': 60, 'start_s': 1, 'end_s': 2},
            {'note': 'E4', 'midi': 64, 'start_s': 2, 'end_s': 3},
            {'note': 'G4', 'midi': 67, 'start_s': 3, 'end_s': 4}]}
        result = widget.from_analysis(data, start_note=1, count=2)
        self.assertEqual([n['pitch'] for n in result['notes']], ['E4', 'G4'])
        self.assertEqual(result['notes'][0]['start'], 2)
        self.assertIn('32.00–34.00', result['caption'])
        self.assertEqual(result['evidence'], 'estimated')
        self.assertEqual(data['notes'][1]['start_s'], 2)
        data['notes'][1]['midi'] = 65
        with self.assertRaisesRegex(ValueError, 'disagrees'):
            widget.from_analysis(data)

    def test_harmony_adapter_includes_only_overlapping_proposal_notes(self):
        data = {'schema': 1, 'excerpt': {'start_s': 10}, 'melody': [
            {'note': 'C4', 'midi': 60, 'start_s': 0, 'end_s': 1},
            {'note': 'D4', 'midi': 62, 'start_s': 1, 'end_s': 2}], 'harmony': [
            {'note': 'E4', 'midi': 64, 'start_s': 0, 'end_s': 1},
            {'note': 'F4', 'midi': 65, 'start_s': 1, 'end_s': 2}]}
        result = widget.from_analysis(data, harmony=True, start_note=1, count=1)
        self.assertEqual([n['pitch'] for n in result['harmony']], ['F4'])
        self.assertEqual(result['evidence'], 'proposed')

    def test_cli_keeps_audio_separate_and_does_not_overwrite_prior_work(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'exercise.wav'
            with wave.open(str(source), 'wb') as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(22050)
                audio.writeframes(b'\0\0' * 2205)
            output = Path(directory) / 'lesson'
            command = [sys.executable, str(SCRIPT), str(widget.ROOT / 'templates/intervals.json'),
                       '--attach', str(source), '--out', str(output)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            response = json.loads((output / 'response.json').read_text())
            self.assertEqual(response['files'], [str(source.resolve())])
            self.assertNotIn(str(source), response['presentation']['content'])
            original = (output / 'response.json').read_bytes()
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((output / 'response.json').read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
