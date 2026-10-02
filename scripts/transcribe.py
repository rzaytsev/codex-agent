"""Local CPU speech recognition; models cache under persistent CODEX_HOME."""
import os
import sys
from faster_whisper import WhisperModel
model = WhisperModel(sys.argv[2], device="cpu", compute_type="int8", download_root=os.path.join(os.environ.get("CODEX_HOME", "/data/codex"), "whisper"))
segments, _ = model.transcribe(sys.argv[1], language=sys.argv[3] or None, vad_filter=True)
print(" ".join(segment.text.strip() for segment in segments))
