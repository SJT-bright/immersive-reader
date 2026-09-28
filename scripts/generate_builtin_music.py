#!/usr/bin/env python3
"""内置氛围音乐生成器：全部为本脚本确定性合成的原创音频，不含任何采样或下载的录音。

用法：
    python3 scripts/generate_builtin_music.py            # 生成全部曲目
    python3 scripts/generate_builtin_music.py --list     # 只看清单
    python3 scripts/generate_builtin_music.py rain-window # 只生成某一首

依赖：Python 3 + numpy（合成）+ ffmpeg（编码 mp3）。这三个只在开发期用到，
运行时产物只是 assets/audio/*.mp3，应用本身仍是零依赖静态站点。

无缝循环的做法：曲式按 `seconds` 周期排布，先多渲染 tail 秒，再把这段尾巴折回开头叠加，
于是循环点没有能量断口；噪声底是平稳随机过程，硬接也听不出来。
"""
from __future__ import annotations

import argparse
import math
import struct
import subprocess
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUDIO_DIR = ROOT / 'assets' / 'audio'
RATE = 24000
TARGET_RMS = 0.045

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


# ---------- 基础声部 ----------
def filtered_noise(length, seed, cutoff_hz, q=1.0):
    """确定性噪声底：固定种子白噪声 + FFT 低通。"""
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(length)
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(length, 1.0 / RATE)
    # 一阶滚降按 q 缩放，越小的截止频率越"远"
    mask = 1.0 / (1.0 + (freqs / max(1.0, cutoff_hz)) ** (1.0 + q))
    return np.fft.irfft(spec * mask, n=length)


def swell(length, period_seconds, depth, loop_seconds):
    """缓慢起伏：在 loop_seconds 上取整数个周期，折叠循环后没有断口。"""
    cycles = max(1, int(round(loop_seconds / period_seconds)))
    t = np.arange(length, dtype=np.float64) / RATE
    return 1.0 + depth * np.sin(2 * math.pi * cycles * t / loop_seconds)


def tile_to(source, length):
    """把按曲长生成的一次素材平铺到 total，保证折叠尾巴时头尾一致。"""
    reps = -(-length // len(source))
    return np.tile(source, reps)[:length]


# ---------- 曲目 ----------
# notes 为 MIDI 音高序列；beat 按 period 秒推进，负拍（上一循环的尾巴）由 tail 折叠产生。

COMPOSITIONS = [
    {
        'file': 'rain-window.mp3',
        'title': '雨窗随想',
        'seconds': 66,
        'period': 1.35,
        'notes': [62, 65, 69, 74, 71, 69, 65, 62, 60, 65, 69, 72, 69, 65, 62, 60],
        'gain': 0.135,
        'decay': 2.4,
        'partials': ((1, 1.0), (2, 0.26), (3, 0.07)),
        'tail': 9.0,
        'bed': {'seed': 20260928, 'cutoff': 1900, 'q': 1.6, 'gain': 0.030, 'swell': (5.5, 0.35)},
        'bass': (50, 0.026),
    },
    {
        'file': 'night-desk.mp3',
        'title': '深夜书房',
        'seconds': 78,
        'period': 2.6,
        'notes': [57, 64, 69, 76, 71, 64, 59, 66, 73, 69, 64, 57],
        'gain': 0.115,
        'decay': 4.2,
        'partials': ((1, 1.0), (2, 0.16), (4, 0.04)),
        'tail': 14.0,
        'bed': {'seed': 19280713, 'cutoff': 420, 'q': 1.1, 'gain': 0.026, 'swell': (13.0, 0.28)},
        'bass': (45, 0.034),
    },
    {
        'file': 'valley-dawn.mp3',
        'title': '山谷晨光',
        'seconds': 66,
        'period': 1.1,
        'notes': [64, 67, 71, 76, 79, 76, 71, 67, 62, 66, 69, 74, 78, 74, 69, 66,
                  60, 64, 67, 72, 76, 72, 67, 64],
        'gain': 0.118,
        'decay': 1.9,
        'partials': ((1, 1.0), (2, 0.30), (3, 0.11), (5, 0.04)),
        'tail': 7.0,
        'bed': {'seed': 730511, 'cutoff': 3200, 'q': 2.2, 'gain': 0.014, 'swell': (11.0, 0.4)},
        'bass': (52, 0.020),
    },
    {
        'file': 'hearth-snow.mp3',
        'title': '壁炉与雪',
        'seconds': 72,
        'period': 3.0,
        'notes': [55, 62, 67, 70, 67, 62, 53, 60, 65, 69, 65, 60],
        'gain': 0.105,
        'decay': 5.0,
        'partials': ((1, 1.0), (2, 0.12), (3, 0.05)),
        'tail': 16.0,
        'bed': {'seed': 4412, 'cutoff': 640, 'q': 0.8, 'gain': 0.034, 'swell': (9.0, 0.45)},
        'crackle': {'seed': 98765, 'gain': 0.020},
        'bass': (43, 0.030),
    },
    {
        'file': 'slow-tide.mp3',
        'title': '海边慢板',
        'seconds': 84,
        'period': 3.5,
        'notes': [59, 66, 71, 78, 74, 66, 57, 64, 69, 76, 71, 64],
        'gain': 0.100,
        'decay': 6.0,
        'partials': ((1, 1.0), (2, 0.14), (3, 0.05)),
        'tail': 19.0,
        'bed': {'seed': 55501, 'cutoff': 900, 'q': 1.3, 'gain': 0.040, 'swell': (21.0, 0.62)},
        'bass': (47, 0.028),
    },
]


def render(comp):
    if np is None:
        sys.exit('需要 numpy 才能合成新曲目：python3 -m pip install numpy')
    seconds, tail, period = comp['seconds'], comp['tail'], comp['period']
    total = int((seconds + tail) * RATE)
    keep = int(seconds * RATE)
    left = np.zeros(total)
    right = np.zeros(total)

    notes = comp['notes']
    beats = int(math.ceil((seconds + tail) / period))
    for b in range(beats):
        start = b * period
        freq = midi(notes[b % len(notes)])
        # 声像在三个位置间缓慢游走，保持确定性
        pan = 0.5 + 0.26 * math.sin(b * 1.7)
        n = int(min(comp['decay'] * 6, seconds + tail - start) * RATE)
        if n <= 0:
            continue
        t = np.arange(n, dtype=np.float64) / RATE
        env = (1.0 - np.exp(-t * 160.0)) * np.exp(-t / comp['decay'])
        wave_ = np.zeros(n)
        for k, amp in comp['partials']:
            wave_ += amp * np.sin(2 * math.pi * freq * k * t)
        voice = wave_ * env * comp['gain']
        i0 = int(start * RATE)
        i1 = min(total, i0 + n)
        seg = i1 - i0
        left[i0:i1] += voice[:seg] * (1.0 - pan) * math.sqrt(2) * 0.5
        right[i0:i1] += voice[:seg] * pan * math.sqrt(2) * 0.5

    # 低音铺底：整段持续，两端淡入淡出，循环处能量连续
    bass_midi, bass_gain = comp.get('bass', (None, 0.0))
    if bass_midi is not None:
        span = int((seconds + tail) * RATE)
        t = np.arange(span, dtype=np.float64) / RATE
        f = midi(bass_midi)
        drone = np.sin(2 * math.pi * f * t) + 0.3 * np.sin(2 * math.pi * f * 2 * t)
        lfo = 1.0 + 0.22 * np.sin(2 * math.pi * round(seconds / 17.0) * t / seconds)
        left[:span] += drone * lfo * bass_gain
        right[:span] += drone * lfo * bass_gain * 0.92

    bed = comp.get('bed')
    if bed:
        base = filtered_noise(keep, bed['seed'], bed['cutoff'], bed['q'])
        period_s, depth = bed['swell']
        base *= swell(keep, period_s, depth, seconds)
        base /= max(1e-9, float(np.max(np.abs(base))))
        noise = tile_to(base, total)
        # 左右用同一底但声像略偏，制造宽度而不引入新的随机
        left += noise * bed['gain']
        right += np.roll(noise, int(0.006 * RATE)) * bed['gain']

    crackle = comp.get('crackle')
    if crackle:
        rng = np.random.default_rng(crackle['seed'])
        impulses = np.zeros(keep)
        # 稀疏短促的"噼"声，位置由固定种子决定
        hits = int(seconds * 2.4)
        pos = rng.integers(0, total, size=hits)
        amp = rng.uniform(0.35, 1.0, size=hits)
        for p, a in zip(pos, amp):
            ln = int(RATE * 0.012)
            i1 = min(keep, p + ln)
            t = np.arange(i1 - p, dtype=np.float64) / RATE
            impulses[p:i1] += a * np.sin(2 * math.pi * rng.uniform(1400, 4200) * t) * np.exp(-t / 0.004)
        impulses /= max(1e-9, float(np.max(np.abs(impulses))))
        impulses = tile_to(impulses, total)
        left += impulses * crackle['gain']
        right += np.roll(impulses, int(0.011 * RATE)) * crackle['gain']

    # 折叠尾巴：把超出曲长的部分加回开头，得到真正的无缝循环
    extra = total - keep
    if extra > 0:
        left[:extra] += left[keep:]
        right[:extra] += right[keep:]
    left = left[:keep]
    right = right[:keep]

    # 软削波前先按响度归一：五首新曲之间切换时音量不该跳。
    # 目标 RMS 0.045（约 -27 dBFS），与已发布的《林间慢读》(0.033) 同一量级，阅读时不抢戏。
    mono = (left + right) / 2
    rms = float(np.sqrt((mono ** 2).mean())) or 1e-9
    trim = TARGET_RMS / rms
    left *= trim
    right *= trim
    peak = max(float(np.max(np.abs(np.concatenate([left, right])))), 1e-9)
    scale = min(1.0, 0.90 / peak)
    left = np.tanh(left * scale) * 0.985
    right = np.tanh(right * scale) * 0.985
    return np.stack([left, right], axis=1)


def write_mp3(samples, out_path, seconds, title):
    wav_path = out_path.with_suffix('.wav')
    out_path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype('<i2')
    with wave.open(str(wav_path), 'wb') as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(RATE)
        f.writeframes(pcm.tobytes())
    try:
        subprocess.run([
            'ffmpeg', '-y', '-loglevel', 'error', '-i', str(wav_path),
            '-codec:a', 'libmp3lame', '-b:a', '96k',
            '-metadata', f'title={title}',
            '-metadata', 'artist=沉浸阅读器内置合成',
            '-metadata', 'comment=原创程序化合成，无采样',
            str(out_path),
        ], check=True)
    finally:
        wav_path.unlink(missing_ok=True)


# ---------- 已发布的《林间慢读》保持原算法逐字不变，重跑也能得到同一个文件 ----------

def render_forest_reading():
    rate, seconds = 24000, 48
    notes = [60, 64, 67, 71, 57, 60, 64, 69, 53, 57, 60, 64, 55, 59, 62, 67]
    frames = bytearray()
    with wave.open(str(AUDIO_DIR / 'forest-reading.wav'), 'wb') as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(rate)
        chunk = bytearray()
        for i in range(rate * seconds):
            t = i / rate
            l = r = 0.0
            for beat in range(max(0, int(t / 1.5) - 7), int(t / 1.5) + 1):
                age = t - beat * 1.5
                freq = 440 * 2 ** ((notes[beat % len(notes)] - 69) / 12)
                env = (1 - math.exp(-age * 5)) * math.exp(-age / 2.7)
                tone = (math.sin(2 * math.pi * freq * age) + .24 * math.sin(2 * math.pi * freq * 2 * age) * math.exp(-age)) * env * .13
                pan = .35 + .3 * ((beat % 3) / 2)
                l += tone * pan
                r += tone * (1 - pan)
            fade = min(1, t / 2, (seconds - t) / 4)
            chunk.extend(struct.pack('<hh', int(math.tanh(l) * fade * 30000), int(math.tanh(r) * fade * 30000)))
            if len(chunk) >= 96000:
                f.writeframes(chunk)
                chunk.clear()
        f.writeframes(chunk)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('only', nargs='?', help='只生成指定文件名（如 rain-window.mp3）')
    parser.add_argument('--list', action='store_true', help='列出全部内置曲目')
    args = parser.parse_args()

    if args.list:
        print('forest-reading.mp3\t林间慢读\t48s\t原创合成拨奏')
        for c in COMPOSITIONS:
            print(f"{c['file']}\t{c['title']}\t{c['seconds']}s\t原创合成氛围（无缝循环）")
        return

    targets = [c for c in COMPOSITIONS if not args.only or c['file'] == args.only]

    if not args.only or args.only == 'forest-reading.mp3':
        AUDIO_DIR.mkdir(parents=True, exist_ok=True)
        render_forest_reading()
        try:
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error',
                            '-i', str(AUDIO_DIR / 'forest-reading.wav'),
                            '-codec:a', 'libmp3lame', '-b:a', '96k',
                            '-metadata', 'title=林间慢读', str(AUDIO_DIR / 'forest-reading.mp3')], check=True)
        finally:
            (AUDIO_DIR / 'forest-reading.wav').unlink(missing_ok=True)
        print(AUDIO_DIR / 'forest-reading.mp3')

    for c in targets:
        out = AUDIO_DIR / c['file']
        out.with_suffix('.wav').unlink(missing_ok=True)
        write_mp3(render(c), out, c['seconds'], c['title'])
        print(f'{out}\t{c["title"]} · {c["seconds"]}s · {out.stat().st_size / 1024:.0f} KB')


if __name__ == '__main__':
    main()
