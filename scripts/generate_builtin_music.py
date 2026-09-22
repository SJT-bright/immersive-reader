#!/usr/bin/env python3
"""Original deterministic ambient composition; no samples or downloaded recordings.
Regenerate with Python 3 and ffmpeg; temporary WAV is removed after encoding.
"""
from pathlib import Path
import math, wave, struct, subprocess
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets/audio/forest-reading.mp3'
RATE, SECONDS = 24000, 48
notes = [60, 64, 67, 71, 57, 60, 64, 69, 53, 57, 60, 64, 55, 59, 62, 67]
wav = OUT.with_suffix('.wav')
OUT.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(wav), 'wb') as f:
    f.setnchannels(2); f.setsampwidth(2); f.setframerate(RATE)
    chunk = bytearray()
    for i in range(RATE * SECONDS):
        t = i / RATE
        left = right = 0.0
        for beat in range(max(0, int(t / 1.5) - 7), int(t / 1.5) + 1):
            age = t - beat * 1.5
            freq = 440 * 2 ** ((notes[beat % len(notes)] - 69) / 12)
            env = (1 - math.exp(-age * 5)) * math.exp(-age / 2.7)
            tone = (math.sin(2 * math.pi * freq * age) + .24 * math.sin(2 * math.pi * freq * 2 * age) * math.exp(-age)) * env * .13
            pan = .35 + .3 * ((beat % 3) / 2)
            left += tone * pan; right += tone * (1-pan)
        fade = min(1, t / 2, (SECONDS - t) / 4)
        chunk.extend(struct.pack('<hh', int(math.tanh(left) * fade * 30000), int(math.tanh(right) * fade * 30000)))
        if len(chunk) >= 96000: f.writeframes(chunk); chunk.clear()
    f.writeframes(chunk)
try:
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(wav), '-codec:a', 'libmp3lame', '-b:a', '96k', '-metadata', 'title=林间慢读', str(OUT)], check=True)
finally:
    wav.unlink(missing_ok=True)
print(OUT)
