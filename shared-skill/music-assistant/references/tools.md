# Tools, setup and reproducible execution

Use a separate environment in the authorized workspace. Python 3.11 is the tested
interpreter; dependencies below are pinned for the helper. Install only when
dependency installation is in scope. The helper never installs packages itself.
System `ffmpeg`/`ffprobe` are required. `rubberband` is required only for `shift`.
SoX, Sonic Annotator and Demucs are optional tools with distinct jobs.

```sh
uv venv --python 3.11 /private/project/music-env
uv pip install --python /private/project/music-env/bin/python \
  -r /path/to/music-assistant/requirements.txt
uv pip install --python /private/project/music-env/bin/python --no-deps basic-pitch==0.4.0
```

Basic Pitch's upstream platform metadata installs CoreML/TensorFlow on some
platforms even when ONNX is used. The separate `--no-deps` install is intentional:
the requirements file supplies the inference dependencies, and the helper loads
the bundled ONNX model explicitly on CPU. Warnings about absent unused model
backends do not mean ONNX inference failed. Dependency-manager checks can report
the deliberately absent platform backend; they do not replace the actual
inference smoke test. Pin upgrades only after rechecking inference and fixtures.

For `features`, install the optional compiled Essentia package:

```sh
uv pip install --python /private/project/music-env/bin/python essentia==2.1b6.dev1389
```

Use a compatible published wheel. If unavailable, report that backend unavailable
or plan a target-platform build separately. Do not silently switch analysis
methods. The tested helper invokes Essentia's C++ algorithms through its Python
bindings; the standalone Essentia extractor binary is not a prerequisite.

Use the environment's Python explicitly. For sandboxed hosts, put `UV_CACHE_DIR`,
`MPLCONFIGDIR`, `NUMBA_CACHE_DIR` and `XDG_CACHE_HOME` in a writable private project
directory when defaults are unavailable. Keep the original audio and generated
results private. `doctor` does not make a model call, download weights or contact
an external transcription service.

## Existing CLIs

- **FFmpeg/ffprobe:** decode, crop, resample, mix and verify media. `analyze`,
  `features` and `shift` create a mono 22.05 kHz excerpt. Original stereo is retained
  unchanged. Inspect channels before downmixing if stereo placement is relevant.
- **SoX:** effects, level statistics and sample preparation. For example,
  `sox input.wav -n stats` measures audio; `sox input.wav excerpt.wav trim 30 20`
  extracts 20 seconds. Refuse an existing output before invoking a raw CLI.
- **Rubber Band:** independent tempo and pitch changes. `--pitch` uses semitones;
  `--tempo 0.8` is slower playback without lowering pitch. The helper records
  these settings and input SHA-256 in `shift.json`.
- **Sonic Annotator + Vamp:** an alternative analysis host. First list installed
  plugins with `sonic-annotator -l`; then choose a real reported output ID:
  `sonic-annotator -d OUTPUT_ID input.wav -w csv --csv-basedir NEW_OUTPUT_DIR`.
  A host with no relevant plugin does not supply pitch recognition. pYIN is for
  a monophonic line; other plugins have their own assumptions.
- **Basic Pitch:** polyphonic audio-to-MIDI estimation. `basic-pitch OUTPUT_DIR
  input.wav --save-note-events` is the upstream CLI; the helper additionally
  preserves source timestamps and produces plots/interval candidates. Best
  results are expected on one instrument at a time, not an arbitrary dense mix.
- **Demucs:** optional CPU stem separation: `python -m demucs.separate -d cpu
  --two-stems vocals -o NEW_OUTPUT_DIR input.wav`. Initial use downloads model
  weights. It produces vocals/accompaniment, not individual choir parts. Source
  separation is not needed for every recording. Its original repository is
  archived; verify a compatible pinned installation before relying on it.

The local separation smoke used `demucs==4.0.1`, `torch==2.5.1` and
`torchaudio==2.5.1`, model `htdemucs`, CPU, `--shifts 0 --segment 7`. Keep these
optional dependencies separate from the minimal transcription requirements.
For a separated **excerpt**, record its parent source, SHA-256 and crop offset
beside the outputs: its own analysis starts at zero, not at the parent recording's
timestamp. Add that offset when explaining a passage. A guide mixed over the
matching original excerpt must use the same origin and sample timing.

The helper has no automatic Demucs/plugin installation, no DAW integration and
no vocal-cloning backend. Missing optional tools should narrow the claim, not
trigger invented results. Audio stays in local processing; installing packages
or initial optional weights requires network access, not uploading the song.

## Sources

- [SoX](https://sourceforge.net/projects/sox/)
- [Rubber Band](https://breakfastquay.com/rubberband/)
- [Sonic Annotator](https://www.vamp-plugins.org/sonic-annotator/)
- [QM Vamp plugins](https://www.vamp-plugins.org/plugin-doc/qm-vamp-plugins.html)
- [Essentia extractors](https://essentia.upf.edu/extractors_out_of_box.html)
- [Basic Pitch](https://github.com/spotify/basic-pitch)
- [librosa fundamental frequency](https://librosa.org/doc/latest/auto_tutorials/01-intro/03-f0.html)
- [Demucs](https://github.com/facebookresearch/demucs)
