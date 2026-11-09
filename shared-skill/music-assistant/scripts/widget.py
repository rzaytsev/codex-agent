#!/usr/bin/env python3
"""Render bounded music lessons as offline Telegram widget final responses."""
from __future__ import annotations

import argparse
import html
import importlib.util
import json
import math
from pathlib import Path
import re
import sys
import zlib

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('music_widget_theory', Path(__file__).with_name('music.py'))
MUSIC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MUSIC)
TYPES = ('melody', 'intervals', 'scale', 'chords', 'harmony')
UI = {
    'en': {'prev': 'Back', 'next': 'Next', 'hide': 'Melody only', 'show': 'Both voices',
           'sending': 'Sending offered request…', 'queued': 'Request accepted · queued',
           'working': 'Agent is working…', 'completed': 'Agent finished · full answer in chat',
           'failed': 'Request failed · try again in chat', 'cancelled': 'Request cancelled',
           'interrupted': 'Request interrupted · continue in chat', 'cancel_requested': 'Cancellation requested',
           'busy': 'Another request is working · please wait', 'expired': 'This control expired · ask in chat',
           'rate_limited': 'Too many requests · please wait', 'unknown_action': 'Control unavailable · ask in chat',
           'melody': 'Melody', 'harmony': 'Proposed harmony', 'silent': 'Visual only · audio/MIDI travel separately.',
           'attached': 'Separate attachments: ', 'example': 'Synthetic teaching example',
           'estimated': 'Estimated notes · verify against audio', 'proposed': 'Proposed choice · audition first',
           'annotated': 'Manually annotated passage', 'steps': 'chromatic steps', 'semitones': 'semitones',
           'degree': 'degree', 'notes': 'Notes', 'seconds': 'seconds from excerpt start', 'beats': 'beats'},
    'ru': {'prev': 'Назад', 'next': 'Далее', 'hide': 'Только мелодия', 'show': 'Оба голоса',
           'sending': 'Отправляем выбранный запрос…', 'queued': 'Запрос принят · в очереди',
           'working': 'Агент работает…', 'completed': 'Готово · полный ответ в чате',
           'failed': 'Запрос не выполнен · напишите в чат', 'cancelled': 'Запрос отменён',
           'interrupted': 'Работа прервана · продолжите в чате', 'cancel_requested': 'Запрошена отмена',
           'busy': 'Другой запрос выполняется · подождите', 'expired': 'Кнопка устарела · напишите в чат',
           'rate_limited': 'Слишком много запросов · подождите', 'unknown_action': 'Кнопка недоступна · напишите в чат',
           'melody': 'Мелодия', 'harmony': 'Предложенный второй голос', 'silent': 'Без звука · аудио и MIDI отправляются отдельно.',
           'attached': 'Отдельные файлы: ', 'example': 'Учебный синтетический пример',
           'estimated': 'Оценка нот · сверяйте с аудио', 'proposed': 'Предложение · сначала послушайте',
           'annotated': 'Фрагмент размечен вручную', 'steps': 'хроматические шаги', 'semitones': 'полутонов',
           'degree': 'ступень', 'notes': 'Ноты', 'seconds': 'секунды от начала фрагмента', 'beats': 'доли'}
}


def text(value: object, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or '\0' in value:
        raise ValueError(f'{label} must be nonempty text within {maximum} characters')
    return value


def items(value: object, label: str, maximum: int = 8) -> list:
    if not isinstance(value, list) or not 1 <= len(value) <= maximum:
        raise ValueError(f'{label} requires 1–{maximum} items; choose a shorter phrase')
    return value


def number(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f'{label} must be finite')
    return float(value)


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def svg(parts: list[str], label: str) -> str:
    return '<svg viewBox="0 0 300 134" role="img" aria-label="' + esc(label) + '">' + ''.join(parts) + '</svg>'


def svg_text(x: float, y: float, value: object, anchor: str = 'middle') -> str:
    return f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}">{esc(value)}</text>'


def events(value: object, label: str) -> list:
    result = []
    for note in items(value, label):
        pitch = text(note['pitch'], 'pitch', 8)
        start, end = number(note['start'], 'start'), number(note['end'], 'end')
        if not 0 <= start < end <= 600:
            raise ValueError('Note times must satisfy 0 <= start < end <= 600')
        result.append({'pitch': pitch, 'midi': MUSIC.parse_note(pitch), 'start': start, 'end': end,
                       'comment': text(note.get('comment', pitch), 'comment', 180)})
    if any(b['start'] < a['end'] for a, b in zip(result, result[1:])):
        raise ValueError('Each voice must be ordered and monophonic; separate overlapping voices')
    return result


def timeline(melody: list, harmony: list, focus: int, frame: int, unit: str) -> tuple[str, list]:
    all_notes = melody + harmony
    low, high = min(n['midi'] for n in all_notes), max(n['midi'] for n in all_notes)
    origin, end = min(n['start'] for n in all_notes), max(n['end'] for n in all_notes)
    duration = end - origin
    y = lambda pitch: 92 - (pitch - low) * 60 / max(4, high - low)
    x = lambda second: 27 + (second-origin) / duration * 250
    parts = [f'<line class="grid" x1="27" y1="{y(p):.1f}" x2="286" y2="{y(p):.1f}"/>'
             for p in sorted({n['midi'] for n in all_notes})]
    points = ' '.join(f'{x((n["start"]+n["end"])/2):.1f},{y(n["midi"]):.1f}' for n in melody)
    parts.append(f'<polyline class="lead soft" style="fill:none" points="{points}"/>')
    identifiers = []
    for voice, notes in (('lead', melody), ('harmony', harmony)):
        for index, note in enumerate(notes):
            active = (index == focus if voice == 'lead' else
                      note['start'] < melody[focus]['end'] and note['end'] > melody[focus]['start'])
            identifier = f'h{frame}_{index}' if voice == 'harmony' else f'n{frame}_{index}'
            if voice == 'harmony':
                identifiers.append(identifier)
            label = note['pitch']
            label_svg = (svg_text(x(note['start']), y(note['midi']) + (17 if voice == 'lead' else -11),
                                  label, 'end' if x(note['start']) > 250 else 'start') if active else '')
            parts.append(f'<g id="{identifier}" class="{voice} {"active" if active else "soft"}">'
                         f'<rect x="{x(note["start"]):.1f}" y="{y(note["midi"])-5:.1f}" '
                         f'width="{max(2,x(note["end"])-x(note["start"])-1):.1f}" height="10" rx="2"/>'
                         f'<title>{esc(label)}</title>{label_svg}</g>')
    parts += [svg_text(27, 128, f'{origin:g}', 'start'), svg_text(286, 128, f'{end:g} {unit}', 'end')]
    return svg(parts, ' / '.join(n['pitch'] for n in all_notes)), identifiers


def lesson_frames(data: dict, ui: dict) -> tuple[list, list, bool]:
    kind = data['type']
    frames, harmony_ids = [], []
    if kind in ('melody', 'harmony'):
        melody = events(data['notes'], 'notes')
        harmony = events(data['harmony'], 'harmony') if kind == 'harmony' else []
        unit = data.get('time_unit', 'seconds')
        if unit not in ('seconds', 'beats'):
            raise ValueError('time_unit must be seconds or beats')
        for index, note in enumerate(melody):
            chart, identifiers = timeline(melody, harmony, index, index, ui[unit])
            harmony_ids += identifiers
            frames.append({'label': note['pitch'], 'text': note['comment'], 'svg': chart})
    elif kind == 'intervals':
        pairs = items(data['pairs'], 'pairs')
        distances = [abs(MUSIC.parse_note(p['upper']) - MUSIC.parse_note(p['lower'])) for p in pairs]
        if max(distances) > 24:
            raise ValueError('Interval comparison is limited to two octaves')
        width = 264 / max(1, max(distances))
        for pair, distance in zip(pairs, distances):
            lower, upper = MUSIC.parse_note(pair['lower']), MUSIC.parse_note(pair['upper'])
            if upper < lower:
                raise ValueError('Use lower <= upper; preserve direction in the explanation')
            parts = [f'<rect class="lead {"active" if i < distance else "soft"}" x="{18+i*width:.1f}" y="45" width="{width-2:.1f}" height="27" rx="2"/>'
                     for i in range(max(1, max(distances)))]
            parts += [f'<line class="harmony active" x1="{18+distance*width:.1f}" y1="40" x2="{18+distance*width:.1f}" y2="78"/>',
                      svg_text(150, 29, f'{pair["lower"]} → {pair["upper"]}'),
                      svg_text(150, 103, f'{distance} {ui["semitones"]}')]
            frames.append({'label': text(pair['label'], 'interval label', 48),
                           'text': text(pair['comment'], 'interval explanation', 180),
                           'svg': svg(parts, f'{pair["lower"]} – {pair["upper"]}: {distance} {ui["steps"]}')})
    elif kind == 'scale':
        root = MUSIC.parse_note(data['tonic'])
        mode = data['mode']
        if mode not in ('major', 'minor'):
            raise ValueError('Scale mode must be major or natural minor')
        offsets = (0, 2, 4, 5, 7, 9, 11, 12) if mode == 'major' else (0, 2, 3, 5, 7, 8, 10, 12)
        labels = [MUSIC.spell_reference_upper(data['tonic'], offset, index+1) for index, offset in enumerate(offsets)]
        comments = items(data['comments'], 'scale comments')
        if len(comments) != 8:
            raise ValueError('Provide one explanation per scale degree, including the octave')
        for index in range(8):
            parts = []
            for j, (label, offset) in enumerate(zip(labels, offsets)):
                x, y = 20+j*37, 97-offset*5
                parts += [f'<circle class="lead {"active" if j == index else "soft"}" cx="{x}" cy="{y}" r="8"/>',
                          svg_text(x, y-14, label), svg_text(x, 126, str(j+1))]
            frames.append({'label': f'{ui["degree"]} {index+1}', 'text': text(comments[index], 'scale explanation', 180),
                           'svg': svg(parts, f'{data["tonic"]} {mode}, {ui["degree"]} {index+1}')})
    elif kind == 'chords':
        progression = items(data['progression'], 'progression')
        for chord in progression:
            pitches = items(chord['notes'], 'chord notes', 5)
            for pitch in pitches:
                MUSIC.parse_note(pitch)
            parts = []
            for i, pitch in enumerate(pitches):
                y = 28 + i*20
                parts += [f'<rect class="lead soft" x="38" y="{y-13}" width="224" height="18" rx="4"/>',
                          svg_text(150, y, pitch)]
            frames.append({'label': text(chord['label'], 'chord label', 48),
                           'text': text(chord['comment'], 'chord explanation', 180),
                           'svg': svg(parts, chord['label'] + ': ' + ', '.join(pitches))})
    return frames, harmony_ids, kind == 'harmony'


def render(data: dict, *, agent_requests: bool = False, attachments: list[str] | None = None) -> dict:
    if not isinstance(data, dict) or data.get('type') not in TYPES:
        raise ValueError('Choose a known music lesson type')
    lang = data.get('lang', 'en')
    if lang not in UI:
        raise ValueError('UI language must be en or ru; lesson copy is supplied in the JSON')
    ui = UI[lang]
    evidence = data.get('evidence', 'example')
    if evidence not in ('example', 'estimated', 'proposed', 'annotated'):
        raise ValueError('Use an explicit evidence label: example, estimated, proposed or annotated')
    title, context = text(data['title'], 'title', 64), text(data['context'], 'context', 96)
    caption = text(data['caption'], 'caption', 900)
    frames, harmony_ids, harmony = lesson_frames(data, ui)
    actions = data.get('actions', []) if agent_requests else []
    if not isinstance(actions, list) or len(actions) > 2:
        raise ValueError('Offer at most two agent requests in a phone-width lesson')
    ids, output_actions = set(), []
    for action in actions:
        identifier = action['id']
        if not isinstance(identifier, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', identifier) or identifier in ids:
            raise ValueError('Action IDs must be unique and use 1–64 ASCII letters, digits, _ or -')
        ids.add(identifier)
        output_actions.append({'id': identifier, 'label': text(action['label'], 'action label', 80),
                               'prompt': text(action['prompt'], 'offered prompt', 2000)})
    files = []
    for attachment in attachments or []:
        path = Path(attachment).resolve(strict=True)
        if not path.is_file() or path.suffix.lower() not in ('.wav', '.mp3', '.flac', '.m4a', '.ogg', '.opus', '.mid', '.midi'):
            raise ValueError('Attach existing audio or MIDI files separately')
        text(path.name, 'attachment filename', 80)
        files.append(str(path))
    if len(files) > 4:
        raise ValueError('Attach at most four relevant listening/MIDI files')
    attached = ui['attached'] + ', '.join(Path(p).name for p in files) if files else ui['silent']
    caption += '\n' + ui[evidence] + '. ' + attached
    if len(caption.encode('utf-16-le')) // 2 > 1024:
        raise ValueError('Readable widget caption must fit 1024 UTF-16 units')
    legend = ('<div class="voices"><span><i class="dot lead"></i>' + esc(ui['melody']) +
              '</span><span><i class="dot harmony"></i>' + esc(ui['harmony']) + '</span></div>') if harmony else ''
    config = {'frames': [{'label': f['label'], 'text': f['text']} for f in frames],
              'harmony': harmony_ids, 'actions': [a['id'] for a in output_actions], 'ui': ui}
    serialized = json.dumps(config, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    values = {'LANG': lang, 'TITLE': esc(title), 'CONTEXT': esc(context), 'EVIDENCE': esc(ui[evidence]),
              'LEGEND': legend, 'FRAMES': ''.join(f'<section id="f{i}" class="frame">{f["svg"]}</section>' for i, f in enumerate(frames)),
              'PREV': esc(ui['prev']), 'NEXT': esc(ui['next']),
              'TOGGLE': '<button id="toggle" type="button"></button>' if harmony else '',
              'ACTIONS': ''.join(f'<button class="agent" type="button" id="a{i}">{esc(a["label"])}</button>' for i, a in enumerate(output_actions)),
              'ATTACHMENTS': esc(attached), 'CONFIG': serialized}
    document = (ROOT / 'templates/widget.html').read_text()
    document = re.sub(r'@@([A-Z]+)@@', lambda match: values[match[1]], document)
    raw, compressed = len(document.encode()), len(zlib.compress(document.encode(), 9))
    if raw > 32768 or compressed > 4096:
        raise ValueError(f'Widget exceeds Telegram limits ({raw} raw / {compressed} compressed bytes); shorten the lesson')
    state = json.dumps({'step': 0, 'show_harmony': True}, separators=(',', ':')) if output_actions else None
    return {'text': caption, 'voice': False, 'files': files, 'outcome': None, 'checkpoint': None,
            'presentation': {'kind': 'widget', 'content': document, 'actions': output_actions, 'state': state}}


def from_analysis(data: dict, *, harmony: bool = False, start_note: int = 0, count: int = 4) -> dict:
    """Select a bounded phrase from existing helper data without inventing a lead."""
    if data.get('schema') != 1 or (not harmony and data.get('mode') != 'monophonic'):
        raise ValueError('Use monophonic analysis for a melody, or a harmony.json proposal; do not infer a choir part')
    if not 0 <= start_note or not 1 <= count <= 8:
        raise ValueError('Choose a nonnegative start-note and 1–8 notes')
    selected = data['melody' if harmony else 'notes'][start_note:start_note+count]
    if not selected:
        raise ValueError('No notes in this selection')
    offset = number(data['excerpt']['start_s'], 'source offset')
    first, last = number(selected[0]['start_s'], 'start'), number(selected[-1]['end_s'], 'end')
    proposed = [n for n in data.get('harmony', []) if n['start_s'] < last and n['end_s'] > first] if harmony else []
    def convert(note):
        pitch = note.get('note', MUSIC.note_name(note['midi']))
        if MUSIC.parse_note(pitch) != note['midi']:
            raise ValueError('Written note disagrees with the source MIDI pitch')
        return {'pitch': pitch, 'start': note['start_s'], 'end': note['end_s']}
    notes = []
    for index, note in enumerate(selected):
        item = convert(note)
        description = f'{item["pitch"]} · {offset+note["start_s"]:.2f}–{offset+note["end_s"]:.2f} s in source. '
        if harmony:
            overlaps = [n for n in proposed if n['start_s'] < note['end_s'] and n['end_s'] > note['start_s']]
            description += ('Proposed against ' + ', '.join(MUSIC.note_name(n['midi']) for n in overlaps) + '. ' if overlaps else 'No proposed note here (rest or omission). ')
            description += 'Check the actual chord and range.'
        elif index:
            distance = note['midi'] - selected[index-1]['midi']
            description += f'{abs(distance)} semitones {"up" if distance>0 else "down" if distance<0 else "repeated"} from the previous estimate. Check audio.'
        else:
            description += 'Estimated pitch, not a verified solo or choir part.'
        item['comment'] = description
        notes.append(item)
    span = f'{offset+first:.2f}–{offset+last:.2f} s in source'
    return {'type': 'harmony' if harmony else 'melody', 'lang': 'en',
            'evidence': 'proposed' if harmony else 'estimated',
            'title': 'Audition a proposed second voice' if harmony else 'Explore an estimated phrase',
            'context': span + ' · chart times start at the analysis excerpt origin',
            'caption': (('Proposed second voice' if harmony else 'Estimated melody') + f' at {span}: ' +
                        '–'.join(n['pitch'] for n in notes) + '. Verify against the recording; this is not a certified transcription or choir-part assignment.'),
            'time_unit': 'seconds', 'notes': notes, 'harmony': [convert(n) for n in proposed]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('lesson', nargs='?', help='Lesson JSON, e.g. templates/melody.json')
    parser.add_argument('--analysis', help='Existing monophonic analysis.json, kept as estimated notes')
    parser.add_argument('--harmony', help='Existing harmony.json proposal')
    parser.add_argument('--start-note', type=int, default=0)
    parser.add_argument('--note-count', type=int, default=4)
    parser.add_argument('--out', required=True, help='New output directory')
    parser.add_argument('--agent-requests', action='store_true', help='Include explicitly offered agent-request buttons')
    parser.add_argument('--attach', action='append', default=[], help='Existing WAV/audio or MIDI path; repeat as needed')
    args = parser.parse_args()
    try:
        if sum(bool(value) for value in (args.lesson, args.analysis, args.harmony)) != 1:
            raise ValueError('Choose one lesson JSON, --analysis FILE, or --harmony FILE')
        data = json.loads(Path(args.lesson or args.analysis or args.harmony).read_text())
        if not args.lesson:
            data = from_analysis(data, harmony=bool(args.harmony), start_note=args.start_note, count=args.note_count)
        result = render(data, agent_requests=args.agent_requests, attachments=args.attach)
        output = Path(args.out).resolve()
        output.mkdir(parents=True, exist_ok=False)
        (output / 'widget.html').write_text(result['presentation']['content'])
        (output / 'response.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'output': str(output), 'html_bytes': len(result['presentation']['content'].encode()),
                          'zlib_bytes': len(zlib.compress(result['presentation']['content'].encode(), 9)),
                          'agent_requests': len(result['presentation']['actions']), 'files': len(result['files'])}))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(f'music widget: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
