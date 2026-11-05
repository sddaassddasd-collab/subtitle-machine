#!/usr/bin/env python3
"""Optional local/offline benchmark; not the production streaming recognizer.

Install faster-whisper separately. First use downloads the selected model;
audio is processed locally. Output intentionally has no fabricated receivedMs.
"""
import argparse
import json
import time
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--model', default='small')
    parser.add_argument('--model-cache')
    parser.add_argument('--language', default='zh')
    parser.add_argument('--vocabulary', help='Optional UTF-8 vocabulary file for a separate prompted trial')
    args = parser.parse_args()
    if not Path(args.audio).is_file():
        parser.error('Audio file does not exist')
    from faster_whisper import WhisperModel
    import numpy as np
    audio = np.frombuffer(subprocess.check_output(['ffmpeg', '-v', 'error', '-i', args.audio,
        '-f', 'f32le', '-ac', '1', '-ar', '16000', '-']), dtype='<f4')
    loaded_at = time.monotonic()
    model = WhisperModel(args.model, device='cpu', compute_type='int8', cpu_threads=4,
                         download_root=args.model_cache)
    started = time.monotonic()
    prompt = Path(args.vocabulary).read_text(encoding='utf-8')[:2000] if args.vocabulary else None
    segments, info = model.transcribe(audio, language=args.language, beam_size=5,
                                      initial_prompt=prompt, condition_on_previous_text=False)
    output = [{'text': s.text, 'startMs': s.start * 1000, 'endMs': s.end * 1000}
              for s in segments]
    result = {'mode': 'offline', 'model': args.model, 'language': info.language,
              'durationSeconds': info.duration, 'prompted': bool(prompt),
              'loadSeconds': started - loaded_at, 'inferenceSeconds': time.monotonic() - started,
              'segments': output,
              'note': 'Whole-file offline inference; segment times are audio positions, not streaming availability or display latency.'}
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'segments'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
