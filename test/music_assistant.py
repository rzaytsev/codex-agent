"""Music semantics and actual audio artifacts; no personal recording in fixtures."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'shared-skill/music-assistant/scripts/music.py'
SPEC = importlib.util.spec_from_file_location('music_helper', SCRIPT)
music = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(music)
HAS_AUDIO = all(importlib.util.find_spec(name) for name in ('numpy', 'soundfile', 'pretty_midi', 'librosa'))


class MusicTheoryTests(unittest.TestCase):
    def test_notes_preserve_octave_and_accidentals(self):
        self.assertEqual(music.parse_note('C4'), 60)
        self.assertEqual(music.parse_note('Bb3'), 58)
        self.assertEqual(music.parse_note('B#3'), 60)
        self.assertEqual(music.parse_note('Cb4'), 59)
        self.assertEqual(music.note_name(72), 'C5')
        for value in ('C', 'H4', 'C99', 'C#4;touch file'):
            with self.assertRaises(ValueError):
                music.parse_note(value)

    def test_compound_intervals_do_not_collapse_octaves(self):
        for distance, name in ((3, 'minor third'), (4, 'major third'), (5, 'perfect fourth'),
                               (7, 'perfect fifth'), (12, 'octave'), (24, '2 octaves')):
            self.assertEqual(music.interval_name(distance), name)
        self.assertEqual(music.interval_name(16), 'major third + 1 octave(s)')

    def test_reference_spelling_distinguishes_third_from_augmented_second(self):
        self.assertEqual(music.spell_reference_upper('C4', 3, 3), 'Eb4')
        self.assertEqual(music.spell_reference_upper('F#4', 4, 3), 'A#4')
        self.assertEqual(music.spell_reference_upper('Cb4', 7, 5), 'Gb4')
        self.assertEqual(music.spell_reference_upper('B3', 12, 8), 'B4')

    def test_diatonic_thirds_alternate_and_respect_below_and_minor(self):
        self.assertEqual([music.harmony_pitch(note, 'C:major', 3, 'above') for note in (60, 62, 64)],
                         [64, 65, 67])
        self.assertEqual(music.harmony_pitch(60, 'C:major', 3, 'below'), 57)
        self.assertEqual(music.harmony_pitch(69, 'A:minor', 3, 'above'), 72)
        self.assertIsNone(music.harmony_pitch(61, 'C:major', 3, 'above'))

    def test_intervals_only_exist_during_overlap(self):
        notes = [music.event(0, 2, 60, .8), music.event(1, 3, 64, .9), music.event(3, 4, 72, .9)]
        self.assertEqual(music.simultaneous_intervals(notes), [
            {'start_s': 1.0, 'end_s': 2.0, 'lower_note': 'C4', 'upper_note': 'E4',
             'semitones': 4, 'interval': 'major third', 'status': 'candidate_from_estimated_notes'}])

    def test_existing_output_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'keep.txt'
            marker.write_text('unchanged')
            with self.assertRaises(FileExistsError):
                music.new_output(directory)
            self.assertEqual(marker.read_text(), 'unchanged')

    def test_invalid_numeric_inputs_are_rejected(self):
        for value in ('nan', 'inf', '-inf'):
            with self.assertRaises(argparse.ArgumentTypeError):
                music.finite(value)


@unittest.skipUnless(HAS_AUDIO, 'Run with the music skill environment for audio tests')
class AudioArtifactTests(unittest.TestCase):
    def test_reference_wav_and_midi_agree_on_fifth(self):
        import numpy as np
        import pretty_midi
        import soundfile as sf
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'reference'
            result = subprocess.run([sys.executable, str(SCRIPT), 'reference', '--note', 'C4',
                                     '--interval', 'P5', '--out', str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            record = json.loads(result.stdout)
            self.assertEqual(record['semitones'], 7)
            audio, sr = sf.read(output / 'together.wav')
            self.assertEqual(sr, 22050)
            self.assertAlmostEqual(len(audio) / sr, 1.8, places=3)
            self.assertGreater(np.max(np.abs(audio)), .1)
            self.assertLessEqual(np.max(np.abs(audio)), .951)
            # Independently verify both audible fundamentals, not just metadata.
            spectrum = np.abs(np.fft.rfft(audio[:33075]))
            frequencies = np.fft.rfftfreq(33075, 1 / sr)
            for expected in (261.625565, 391.995436):
                region = np.where(np.abs(frequencies - expected) < 3)[0]
                found = frequencies[region[np.argmax(spectrum[region])]]
                self.assertAlmostEqual(found, expected, delta=1)
            midi = pretty_midi.PrettyMIDI(str(output / 'interval.mid'))
            self.assertEqual([track.notes[0].pitch for track in midi.instruments], [60, 67])

    def test_monophonic_analysis_recovers_known_sequence_with_source_offset(self):
        import numpy as np
        import soundfile as sf
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'synthetic.wav'
            notes = [music.event(.2, 1.2, 60, 1), music.event(1.4, 2.4, 64, 1), music.event(2.6, 3.6, 67, 1)]
            audio = music.synthesize(notes, 4)
            sf.write(source, np.concatenate([np.zeros(22050), audio]), 22050)
            output = Path(directory) / 'analysis'
            result = subprocess.run([sys.executable, str(SCRIPT), 'analyze', str(source),
                                     '--mode', 'monophonic', '--start', '1', '--duration', '4',
                                     '--out', str(output)], capture_output=True, text=True, timeout=180)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads((output / 'analysis.json').read_text())
            self.assertEqual([n['midi'] for n in data['notes']], [60, 64, 67])
            for note in data['notes']:
                self.assertAlmostEqual(note['source_start_s'] - note['start_s'], 1, places=4)
            self.assertTrue(all(abs(n['median_cents_from_note']) < 20 for n in data['notes']))
            self.assertEqual([n['interval'] for n in data['melodic_intervals']], ['major third', 'minor third'])
            harmony = Path(directory) / 'harmony'
            result = subprocess.run([sys.executable, str(SCRIPT), 'harmonize', str(output / 'analysis.json'),
                                     '--key', 'C:major', '--degree', '3', '--out', str(harmony)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            proposed = json.loads((harmony / 'harmony.json').read_text())
            self.assertEqual([n['midi'] for n in proposed['harmony']], [64, 67, 71])

    def test_polyphonic_analysis_is_refused_as_harmony_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'analysis.json'
            source.write_text(json.dumps({'schema': 1, 'mode': 'polyphonic'}))
            result = subprocess.run([sys.executable, str(SCRIPT), 'harmonize', str(source), '--interval', 'M3',
                                     '--out', str(Path(directory) / 'harmony')], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('requires monophonic analysis', result.stderr)
            self.assertFalse((Path(directory) / 'harmony').exists())


if __name__ == '__main__':
    unittest.main()
