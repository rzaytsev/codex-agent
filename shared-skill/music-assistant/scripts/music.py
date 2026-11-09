#!/usr/bin/env python3
"""Local music analysis, interval references and harmony guides. See ../SKILL.md."""
from __future__ import annotations

import argparse
import contextlib
import csv
import hashlib
import importlib.metadata
import importlib.util
import itertools
import json
import math
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

NOTE_NAMES = ('C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B')
INTERVALS = ('unison', 'minor second', 'major second', 'minor third',
             'major third', 'perfect fourth', 'tritone', 'perfect fifth',
             'minor sixth', 'major sixth', 'minor seventh', 'major seventh', 'octave')
NAMED_INTERVALS = {'m3': 3, 'M3': 4, 'P4': 5, 'P5': 7, 'P8': 12}


def run(command: list[str], timeout: int = 300) -> str:
    """No shell interpolation; propagate subprocess failure rather than guessing."""
    try:
        return subprocess.run(command, check=True, capture_output=True, text=True,
                              timeout=timeout).stdout
    except FileNotFoundError as exc:
        raise ValueError(f'Required executable unavailable: {command[0]}') from exc
    except subprocess.CalledProcessError as exc:
        raise ValueError(f'{command[0]} failed: {exc.stderr[-1800:]}') from exc


def finite(value: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise argparse.ArgumentTypeError('Value must be finite')
    return result


def note_name(midi: int) -> str:
    return f'{NOTE_NAMES[midi % 12]}{midi // 12 - 1}'


def parse_note(value: str) -> int:
    match = re.fullmatch(r'([A-Ga-g])([#b]?)(-?\d+)', value)
    if not match:
        raise ValueError('Use a note with octave, e.g. C4, F#3 or Bb4')
    letter, accidental, octave = match.groups()
    pitch = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}[letter.upper()]
    midi = (int(octave) + 1) * 12 + pitch + {'': 0, '#': 1, 'b': -1}[accidental]
    if not 0 <= midi <= 127:
        raise ValueError('Note is outside the MIDI range')
    return midi


def interval_name(semitones: int) -> str:
    distance = abs(semitones)
    if distance <= 12:
        return INTERVALS[distance]
    octaves, remainder = divmod(distance, 12)
    if remainder == 0:
        return f'{octaves} octaves'
    return f'{INTERVALS[remainder]} + {octaves} octave(s)'


def spell_reference_upper(root: str, semitones: int, degree: int) -> str:
    """Known reference intervals have diatonic spelling, unlike inferred MIDI."""
    match = re.fullmatch(r'([A-Ga-g])([#b]?)(-?\d+)', root)
    if not match:
        raise ValueError('Reference requires a spelled note with an octave')
    letter, _, octave = match.groups()
    steps = 'CDEFGAB'.index(letter.upper()) + degree - 1
    octave_delta, index = divmod(steps, 7)
    target = f'{"CDEFGAB"[index]}{int(octave) + octave_delta}'
    accidental = parse_note(root) + semitones - parse_note(target)
    return f'{target[0]}{("#" * accidental) if accidental >= 0 else ("b" * -accidental)}{target[1:]}'


def new_output(path: str) -> Path:
    target = Path(path).resolve()
    # A new directory makes reruns explicit and never overwrites previous work.
    target.mkdir(parents=True, exist_ok=False)
    return target


def save_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + '\n')


def versions() -> dict:
    result = {'python': sys.version.split()[0]}
    for package in ('numpy', 'librosa', 'basic-pitch', 'onnxruntime', 'essentia',
                    'matplotlib', 'soundfile', 'pretty-midi'):
        try:
            result[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            result[package] = None
    return result


def probe(file: str) -> dict:
    source = Path(file).resolve(strict=True)
    if not source.is_file():
        raise ValueError('Input must be a regular audio file')
    data = json.loads(run(['ffprobe', '-v', 'error', '-select_streams', 'a:0',
                           '-show_entries', 'format=duration,size:stream=codec_name,sample_rate,channels',
                           '-of', 'json', str(source)]))
    if not data.get('streams'):
        raise ValueError('No audio stream found')
    duration = float(data['format']['duration'])
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError('Audio must have a known positive duration')
    digest = hashlib.sha256()
    with source.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return {'path': str(source), 'sha256': digest.hexdigest(), 'duration_s': duration,
            'bytes': source.stat().st_size, **data['streams'][0]}


def excerpt(source: dict, output: Path, start: float, duration: float) -> float:
    if start < 0 or start >= source['duration_s'] or not 0 < duration <= 600:
        raise ValueError('Choose a valid start and a duration in (0, 600] seconds')
    duration = min(duration, source['duration_s'] - start)
    run(['ffmpeg', '-nostdin', '-v', 'error', '-n', '-ss', str(start), '-i', source['path'],
         '-t', str(duration), '-vn', '-ac', '1', '-ar', '22050', '-c:a', 'pcm_s16le', str(output)])
    return duration


def event(start: float, end: float, midi: int, score: float) -> dict:
    return {'start_s': round(float(start), 5), 'end_s': round(float(end), 5),
            'midi': int(midi), 'note': note_name(int(midi)), 'score': round(float(score), 4)}


def monophonic(audio, sr: int, low: int, high: int, minimum: float, a4: float) -> tuple[list, list]:
    import librosa
    import numpy as np

    f0, voiced, probabilities = librosa.pyin(
        audio, sr=sr, fmin=a4 * 2 ** ((low - 69) / 12),
        fmax=a4 * 2 ** ((high - 69) / 12), frame_length=2048, hop_length=256)
    times = librosa.times_like(f0, sr=sr, hop_length=256)
    pitches = np.full(len(f0), np.nan)
    valid = voiced & np.isfinite(f0) & (probabilities >= 0.5)
    pitches[valid] = 69 + 12 * np.log2(f0[valid] / a4)
    frames, notes, current = [], [], None
    for index, pitch in enumerate(pitches):
        frames.append({'time_s': round(float(times[index]), 5),
                       'midi_float': float(pitch) if np.isfinite(pitch) else None,
                       'voicing_probability': float(probabilities[index])})
        label = int(round(pitch)) if np.isfinite(pitch) else None
        if label != current:
            if current is not None:
                end = min(float(times[index]), len(audio) / sr)
                if end - begin >= minimum:
                    segment = pitches[first:index]
                    value = event(begin, end, current, float(np.mean(probabilities[first:index])))
                    value['median_cents_from_note'] = round(float(np.median(segment - current) * 100), 2)
                    notes.append(value)
            current, begin, first = label, float(times[index]), index
    if current is not None:
        end = len(audio) / sr
        if end - begin >= minimum:
            value = event(begin, end, current, float(np.mean(probabilities[first:])))
            value['median_cents_from_note'] = round(float(np.median(pitches[first:] - current) * 100), 2)
            notes.append(value)
    return notes, frames


def polyphonic(path: Path, low: int, high: int, minimum: float) -> list:
    # Explicitly select the bundled CPU ONNX model, independent of other installed runtimes.
    with contextlib.redirect_stdout(sys.stderr):
        import onnxruntime
        onnxruntime.disable_telemetry_events()
        from basic_pitch import FilenameSuffix, build_icassp_2022_model_path
        from basic_pitch.inference import Model, predict
        model = Model(build_icassp_2022_model_path(FilenameSuffix.onnx))
        _, _, events = predict(str(path), model, minimum_frequency=440 * 2 ** ((low - 69) / 12),
                               maximum_frequency=440 * 2 ** ((high - 69) / 12),
                               minimum_note_length=minimum * 1000,
                               multiple_pitch_bends=False)
    return sorted([event(start, end, pitch, amplitude)
                   for start, end, pitch, amplitude, _ in events], key=lambda item: (item['start_s'], item['midi']))


def simultaneous_intervals(notes: list) -> list:
    """Sweep boundaries; pair detected pitches without claiming singer identities."""
    boundaries = {}
    for index, note in enumerate(notes):
        boundaries.setdefault(note['start_s'], [[], []])[0].append(index)
        boundaries.setdefault(note['end_s'], [[], []])[1].append(index)
    active, results = set(), []
    points = sorted(boundaries)
    for start, end in zip(points, points[1:]):
        additions, removals = boundaries[start]
        active.difference_update(removals)
        active.update(additions)
        if len(active) > 32:
            raise ValueError('More than 32 simultaneous estimates; narrow the passage or frequency range')
        for first, second in itertools.combinations(sorted(active, key=lambda i: notes[i]['midi']), 2):
            lower, upper = notes[first], notes[second]
            gap = upper['midi'] - lower['midi']
            results.append({'start_s': start, 'end_s': end, 'lower_note': lower['note'],
                            'upper_note': upper['note'], 'semitones': gap,
                            'interval': interval_name(gap), 'status': 'candidate_from_estimated_notes'})
    return results


def melodic_intervals(notes: list) -> list:
    return [{'start_s': a['start_s'], 'end_s': b['end_s'], 'from_note': a['note'],
             'to_note': b['note'], 'semitones': b['midi'] - a['midi'],
             'direction': 'up' if b['midi'] > a['midi'] else 'down' if b['midi'] < a['midi'] else 'same',
             'interval': interval_name(b['midi'] - a['midi'])}
            for a, b in zip(notes, notes[1:])]


def write_midi(path: Path, tracks: list[tuple[str, list]]) -> None:
    import pretty_midi
    midi = pretty_midi.PrettyMIDI()
    for name, notes in tracks:
        instrument = pretty_midi.Instrument(0, name=name)
        for note in notes:
            instrument.notes.append(pretty_midi.Note(80, note['midi'], note['start_s'], note['end_s']))
        midi.instruments.append(instrument)
    midi.write(str(path))


def synthesize(notes: list, duration: float, a4: float = 440) -> object:
    import numpy as np
    result = np.zeros(int(math.ceil(duration * 22050)), dtype=np.float32)
    for note in notes:
        begin = max(0, round(note['start_s'] * 22050))
        end = min(len(result), round(note['end_s'] * 22050))
        if end <= begin:
            continue
        seconds = np.arange(end - begin) / 22050
        frequency = a4 * 2 ** ((note['midi'] - 69) / 12)
        envelope = np.minimum(1, seconds / .01) * np.minimum(1, (end - begin - np.arange(end - begin)) / 220.5)
        result[begin:end] += (np.sin(2 * np.pi * frequency * seconds) * envelope * .2).astype(np.float32)
    return result


def write_wav(path: Path, audio) -> None:
    import numpy as np
    import soundfile as sf
    peak = float(np.max(np.abs(audio))) if len(audio) else 0
    sf.write(str(path), audio / max(1, peak / .95), 22050, subtype='PCM_16')


def plot_notes(path: Path, tracks: list, title: str, offset: float = 0,
               frames: list | None = None, duration: float | None = None) -> None:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.patches import Rectangle

    figure, axis = plt.subplots(figsize=(13, 5), layout='constrained')
    colors = ('#126b8c', '#c45621')
    all_notes = [note for _, notes in tracks for note in notes]
    for index, (name, notes) in enumerate(tracks):
        for note in notes:
            axis.add_patch(Rectangle((note['start_s'] + offset, note['midi'] - .35),
                                     note['end_s'] - note['start_s'], .7, color=colors[index % 2], alpha=.6))
        axis.plot([], [], color=colors[index % 2], linewidth=6, label=name)
    if frames:
        axis.plot([f['time_s'] + offset for f in frames],
                  [f['midi_float'] for f in frames], color='#20292e', linewidth=.8, label='Measured pitch (gaps = unvoiced)')
    if all_notes:
        low, high = min(n['midi'] for n in all_notes), max(n['midi'] for n in all_notes)
        axis.set_ylim(low - 2, high + 2)
        ticks = list(range(low, high + 1, max(1, (high - low) // 20)))
        labels = {note['midi']: note['note'] for note in all_notes}
        axis.set_yticks(ticks, [labels.get(i, note_name(i)) for i in ticks])
        axis.set_xlim(offset, offset + (duration if duration is not None else max(n['end_s'] for n in all_notes) + .1))
    else:
        axis.text(.5, .5, 'No notes met the detection thresholds', ha='center', transform=axis.transAxes)
    axis.set(title=title, xlabel='Time in source recording (seconds)', ylabel='Pitch / octave')
    axis.grid(alpha=.2)
    axis.legend(loc='upper right')
    figure.savefig(path, dpi=160)
    plt.close(figure)


def analyze(args) -> dict:
    if not 0 <= args.min_midi < args.max_midi <= 127 or not .03 <= args.min_note <= 2:
        raise ValueError('Invalid pitch range or minimum note length')
    if not 400 <= args.a4 <= 480:
        raise ValueError('Reference A4 must be between 400 and 480 Hz')
    if args.mode == 'polyphonic' and args.a4 != 440:
        raise ValueError('Basic Pitch uses A4=440; use monophonic mode for another tuning reference')
    source = probe(args.file)
    output = new_output(args.out)
    duration = excerpt(source, output / 'excerpt.wav', args.start, args.duration)
    import soundfile as sf
    audio, sr = sf.read(str(output / 'excerpt.wav'))
    began = time.monotonic()
    if args.mode == 'monophonic':
        notes, frames = monophonic(audio, sr, args.min_midi, args.max_midi, args.min_note, args.a4)
    else:
        notes, frames = polyphonic(output / 'excerpt.wav', args.min_midi, args.max_midi, args.min_note), []
    notes = [n for n in notes if n['start_s'] < duration and n['end_s'] > 0]
    for note in notes:
        note['end_s'] = min(note['end_s'], duration)
        note['source_start_s'] = round(args.start + note['start_s'], 5)
        note['source_end_s'] = round(args.start + note['end_s'], 5)
    warnings = ['Estimated pitches are not a verified score or identified choir parts.',
                'Interval names use chromatic distance; enharmonic spelling requires musical context.',
                'Score is model activation or voicing probability, not calibrated note accuracy.',
                'MIDI and guide notes are quantized; consult pitch curves/source for expressive tuning.']
    if source['channels'] > 1:
        warnings.append('Analysis excerpt is downmixed to mono; the original stereo file is unchanged.')
    if args.mode == 'monophonic':
        warnings.append('Monophonic mode assumes one isolated melodic source; mixed audio can produce false notes.')
    else:
        warnings.append('Harmonics, accompaniment and separation artifacts can produce false simultaneous intervals.')
    result = {'schema': 1, 'status': 'estimated', 'source': source,
              'excerpt': {'start_s': args.start, 'duration_s': duration, 'sample_rate': sr},
              'mode': args.mode, 'a4_hz': args.a4, 'notes': notes,
              'intervals': simultaneous_intervals(notes),
              'melodic_intervals': melodic_intervals(notes) if args.mode == 'monophonic' else [],
              'parameters': {'min_midi': args.min_midi, 'max_midi': args.max_midi, 'min_note_s': args.min_note},
              'analysis_seconds': round(time.monotonic() - began, 3),
              'versions': versions(), 'warnings': warnings}
    save_json(output / 'analysis.json', result)
    if frames:
        save_json(output / 'pitch-curve.json', {'source_offset_s': args.start, 'frames': frames})
    with (output / 'notes.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=['start_s', 'end_s', 'source_start_s', 'source_end_s',
                                                   'midi', 'note', 'score', 'median_cents_from_note'], extrasaction='ignore')
        writer.writeheader()
        writer.writerows(notes)
    write_midi(output / 'estimated.mid', [('Estimated notes (not singer identities)', notes)])
    write_wav(output / 'estimated-guide.wav', synthesize(notes, duration, args.a4))
    if args.visual:
        plot_notes(output / 'piano-roll.png', [('Estimated notes', notes)],
                   'Estimated notes — verify against the recording', args.start, duration=duration)
        if frames:
            plot_notes(output / 'pitch-curve.png', [('Quantized notes', notes)],
                       'Pitch tracking — isolated melody assumption', args.start, frames, duration)
    report = (f'# Music analysis\n\nPassage: {args.start:.2f}–{args.start + duration:.2f} s. '
              f'Mode: {args.mode}. Detected note events: {len(notes)}.\n\n'
              'Note times in CSV include absolute source times; MIDI starts at the excerpt origin.\n\n'
              + '\n'.join(f'- {warning}' for warning in warnings) + '\n')
    (output / 'report.md').write_text(report)
    return {'output': str(output), 'note_events': len(notes), 'interval_candidates': len(result['intervals']),
            'analysis_seconds': result['analysis_seconds'], 'status': result['status']}


def harmony_pitch(midi: int, key: str, degree: int, direction: str) -> int | None:
    match = re.fullmatch(r'([A-G][#b]?):(major|minor)', key)
    if not match:
        raise ValueError('Use a key such as C:major or A:minor (natural minor)')
    tonic = parse_note(match[1] + '4') % 12
    scale = (0, 2, 4, 5, 7, 9, 11) if match[2] == 'major' else (0, 2, 3, 5, 7, 8, 10)
    octave, pitch_class = divmod(midi - tonic, 12)
    if pitch_class not in scale:
        return None
    target = octave * 7 + scale.index(pitch_class) + (degree - 1) * (1 if direction == 'above' else -1)
    target_octave, target_degree = divmod(target, 7)
    return tonic + target_octave * 12 + scale[target_degree]


def harmonize(args) -> dict:
    source_path = Path(args.analysis).resolve(strict=True)
    data = json.loads(source_path.read_text())
    if data.get('schema') != 1 or data.get('mode') != 'monophonic':
        raise ValueError('Harmony requires monophonic analysis of an isolated or manually verified melody')
    if not 0 <= args.min_midi < args.max_midi <= 127:
        raise ValueError('Invalid harmony range')
    if args.key:
        harmony_pitch(60, args.key, args.degree, args.direction)
    harmony, omitted = [], []
    for note in data['notes']:
        target = (harmony_pitch(note['midi'], args.key, args.degree, args.direction) if args.key
                  else note['midi'] + NAMED_INTERVALS[args.interval] * (1 if args.direction == 'above' else -1))
        if target is None or not args.min_midi <= target <= args.max_midi:
            omitted.append({'start_s': note['start_s'], 'note': note['note'],
                            'reason': 'outside key' if target is None else 'outside requested range'})
            continue
        harmony.append(event(note['start_s'], note['end_s'], target, note['score']))
    output = new_output(args.out)
    result = {'schema': 1, 'status': 'proposed_guide_not_verified_arrangement',
              'source_analysis': str(source_path), 'source_sha256': data['source']['sha256'],
              'key': args.key, 'degree': args.degree if args.key else None,
              'fixed_interval': args.interval if not args.key else None, 'direction': args.direction,
              'excerpt': data['excerpt'], 'melody': data['notes'], 'harmony': harmony, 'omitted': omitted,
              'warnings': ['Key and chord suitability must be checked by the musician.',
                           'Scale-based intervals do not account for changing chords, suspensions or voice leading.',
                           'Audio previews are synthesized guide tones, not a generated singing voice.']}
    save_json(output / 'harmony.json', result)
    tracks = [('Estimated melody', data['notes']), ('Proposed harmony', harmony)]
    write_midi(output / 'harmony.mid', tracks)
    duration = data['excerpt']['duration_s']
    melody_audio = synthesize(data['notes'], duration, data['a4_hz'])
    harmony_audio = synthesize(harmony, duration, data['a4_hz'])
    write_wav(output / 'melody-guide.wav', melody_audio)
    write_wav(output / 'harmony-guide.wav', harmony_audio)
    write_wav(output / 'together.wav', melody_audio + harmony_audio)
    if args.visual:
        plot_notes(output / 'harmony.png', tracks, 'Proposed harmony — synthesized guides',
                   data['excerpt']['start_s'], duration=duration)
    return {'output': str(output), 'harmony_notes': len(harmony), 'omitted_notes': len(omitted), 'status': result['status']}


def reference(args) -> dict:
    import numpy as np
    lower = parse_note(args.note)
    upper = lower + NAMED_INTERVALS[args.interval]
    if upper > 127:
        raise ValueError('Upper note exceeds MIDI range')
    output = new_output(args.out)
    first, second = [event(0, 1.5, lower, 1)], [event(0, 1.5, upper, 1)]
    first[0]['note'] = args.note[0].upper() + args.note[1:]
    second[0]['note'] = spell_reference_upper(args.note, upper - lower,
                                            {'m3': 3, 'M3': 3, 'P4': 4, 'P5': 5, 'P8': 8}[args.interval])
    a, b = synthesize(first, 1.8), synthesize(second, 1.8)
    write_wav(output / 'together.wav', a + b)
    write_wav(output / 'sequential.wav', np.concatenate([a, np.zeros(4410), b]))
    write_midi(output / 'interval.mid', [('Lower note', first), ('Upper note', second)])
    result = {'status': 'synthetic_reference', 'lower': first[0]['note'], 'upper': second[0]['note'],
              'interval': interval_name(upper - lower), 'semitones': upper - lower, 'a4_hz': 440}
    save_json(output / 'interval.json', result)
    if args.visual:
        plot_notes(output / 'interval.png', [('Lower note', first), ('Upper note', second)],
                   f'{result["lower"]} + {result["upper"]}: {result["interval"]}', duration=1.8)
    return {'output': str(output), **result}


def features(args) -> dict:
    source = probe(args.file)
    output = new_output(args.out)
    excerpt(source, output / 'excerpt.wav', args.start, args.duration)
    with contextlib.redirect_stdout(sys.stderr):
        import essentia.standard as es
        audio = es.MonoLoader(filename=str(output / 'excerpt.wav'), sampleRate=44100)()
        bpm, beats, strength, _, _ = es.RhythmExtractor2013(method='multifeature')(audio)
        key, scale, key_strength = es.KeyExtractor(sampleRate=44100)(audio)
    result = {'schema': 1, 'source': source, 'start_s': args.start, 'status': 'estimated',
              'bpm': float(bpm), 'beat_times_source_s': [float(x) + args.start for x in beats],
              'rhythm_strength': float(strength), 'key': key, 'scale': scale,
              'key_strength': float(key_strength), 'versions': versions(),
              'warnings': ['Key and tempo are estimates; strength values are not calibrated probabilities.',
                           'Short excerpts, modulations and half/double tempo can change the interpretation.']}
    save_json(output / 'features.json', result)
    return {'output': str(output), 'bpm': result['bpm'], 'key': key, 'scale': scale, 'status': 'estimated'}


def shift(args) -> dict:
    source = probe(args.file)
    if not -24 <= args.semitones <= 24 or not .25 <= args.tempo <= 4:
        raise ValueError('Use semitones in [-24, 24] and tempo in [0.25, 4]')
    output = new_output(args.out)
    duration = excerpt(source, output / 'excerpt.wav', args.start, args.duration)
    run(['rubberband', '--pitch', str(args.semitones), '--tempo', str(args.tempo),
         str(output / 'excerpt.wav'), str(output / 'shifted.wav')])
    result = {'source': source, 'start_s': args.start, 'duration_s': duration,
              'semitones': args.semitones, 'tempo_multiplier': args.tempo,
              'warning': 'All sounds in the excerpt are shifted. This is not an isolated vocal harmony.'}
    save_json(output / 'shift.json', result)
    return {'output': str(output), **result}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('doctor', help='Report installed executables and Python packages; no downloads')
    inspect = commands.add_parser('probe', help='Inspect original metadata and SHA-256')
    inspect.add_argument('file')
    for name in ('analyze', 'features', 'shift'):
        command = commands.add_parser(name)
        command.add_argument('file')
        command.add_argument('--start', type=finite, default=0)
        command.add_argument('--duration', type=finite, default=30)
        command.add_argument('--out', required=True, help='New output directory; existing paths are refused')
        if name == 'analyze':
            command.add_argument('--mode', choices=['monophonic', 'polyphonic'], default='polyphonic')
            command.add_argument('--min-midi', type=int, default=36)
            command.add_argument('--max-midi', type=int, default=96)
            command.add_argument('--min-note', type=finite, default=.12)
            command.add_argument('--a4', type=finite, default=440)
            command.add_argument('--visual', action='store_true', help='Render plots when useful to the explanation')
        if name == 'shift':
            command.add_argument('--semitones', type=finite, required=True)
            command.add_argument('--tempo', type=finite, default=1)
    command = commands.add_parser('reference', help='Generate an interval listening exercise')
    command.add_argument('--note', required=True)
    command.add_argument('--interval', choices=NAMED_INTERVALS, required=True)
    command.add_argument('--out', required=True)
    command.add_argument('--visual', action='store_true')
    command = commands.add_parser('harmonize', help='Generate a proposed guide from an isolated melody')
    command.add_argument('analysis')
    choice = command.add_mutually_exclusive_group(required=True)
    choice.add_argument('--key', help='Diatonic key: C:major, A:minor (natural minor)')
    choice.add_argument('--interval', choices=NAMED_INTERVALS, help='Fixed chromatic interval, not scale-aware')
    command.add_argument('--degree', type=int, choices=[3, 4, 5, 8], default=3)
    command.add_argument('--direction', choices=['above', 'below'], default='above')
    command.add_argument('--min-midi', type=int, default=36)
    command.add_argument('--max-midi', type=int, default=96)
    command.add_argument('--out', required=True)
    command.add_argument('--visual', action='store_true')
    args = parser.parse_args()
    try:
        if args.command == 'doctor':
            result = {'executables': {name: shutil.which(name) for name in
                                     ('ffmpeg', 'ffprobe', 'sox', 'rubberband', 'sonic-annotator',
                                      'essentia_streaming_extractor_music', 'basic-pitch', 'demucs')},
                      'packages': versions(),
                      'demucs_python': importlib.util.find_spec('demucs') is not None}
        elif args.command == 'probe':
            result = probe(args.file)
        else:
            result = {'analyze': analyze, 'reference': reference, 'harmonize': harmonize,
                      'features': features, 'shift': shift}[args.command](args)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except (ValueError, OSError, ImportError, subprocess.TimeoutExpired, KeyError) as exc:
        print(f'music: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
