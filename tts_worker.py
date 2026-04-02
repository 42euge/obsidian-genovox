#!/usr/bin/env python3
"""Kokoro TTS streaming worker for Obsidian plugin.

Generates audio chunk-by-chunk, streaming raw PCM float32 data to stdout.
Each chunk is prefixed with a 4-byte little-endian uint32 size header.
Progress/metadata goes to stderr as JSON lines.

Usage:
    python tts_worker.py --input text.txt [--voice af_heart] [--speed 1.0] [--lang a]
"""

import argparse
import json
import random
import re
import struct
import sys
import time
from pathlib import Path

import numpy as np
import yaml

CONFIG_PATH = Path.home() / ".genotools" / "tts" / "config.yaml"


def load_config() -> dict:
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            return yaml.safe_load(f) or {}
    return {}


def resolve_voice(config: dict) -> str:
    voice = config.get("voice", "af_heart")
    if voice in ("af_random", "am_random"):
        pool = config.get("voice_pool", [])
        if not pool:
            prefix = voice[:2]
            pool = {
                "af": ["af_heart", "af_bella", "af_sarah", "af_nova", "af_sky",
                       "af_alloy", "af_aoede", "af_jessica", "af_kore",
                       "af_nicole", "af_river"],
                "am": ["am_adam", "am_michael", "am_fenrir", "am_echo",
                       "am_eric", "am_liam", "am_onyx", "am_puck"],
            }.get(prefix, ["af_heart"])
        voice = random.choice(pool)
    return voice


def clean_markdown_for_tts(text: str) -> str:
    """Strip markdown formatting and clean text for speech."""
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    text = re.sub(r"!\[.*?\]\(.*?\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"[*_`~]", "", text)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
    text = re.sub(r"`[^`]+`", "", text)
    text = re.sub(r"^[-*_]{3,}\s*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"^>\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^[\s]*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^[\s]*\d+\.\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\[\[([^|\]]+\|)?([^\]]+)\]\]", r"\2", text)
    text = re.sub(r"#[a-zA-Z]\S*", "", text)
    text = re.sub(r"^---\s*\n.*?\n---\s*\n", "", text, flags=re.DOTALL)
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"\[[\d,\s\-–]+\]", "", text)
    text = re.sub(r"\([A-Z][a-z]+(?:\s+et\s+al\.?)?,?\s*\d{4}\)", "", text)
    text = text.replace("→", " leads to ")
    text = text.replace("←", " from ")
    text = text.replace("≥", " greater than or equal to ")
    text = text.replace("≤", " less than or equal to ")
    text = text.replace("±", " plus or minus ")
    text = text.replace("×", " times ")
    text = text.replace("%", " percent")
    text = text.replace("&", " and ")
    text = re.sub(r"\$[^$]+\$", "", text)
    text = re.sub(r"\|", " ", text)
    text = re.sub(r"^[\s]*[-:]+[\s]*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"  +", " ", text)
    return text.strip()


def split_into_chunks(text: str, max_chars: int = 400) -> list:
    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks = []
    current = ""
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(current) + len(sentence) + 1 > max_chars and current:
            chunks.append(current.strip())
            current = sentence
        else:
            current = f"{current} {sentence}" if current else sentence
    if current.strip():
        chunks.append(current.strip())
    return chunks


def progress(msg: str, data: dict = None):
    payload = {"message": msg}
    if data:
        payload.update(data)
    print(json.dumps(payload), file=sys.stderr, flush=True)


def write_audio_chunk(audio_data: np.ndarray):
    """Write a chunk of float32 PCM audio to stdout with a size header."""
    pcm_bytes = audio_data.astype(np.float32).tobytes()
    sys.stdout.buffer.write(struct.pack("<I", len(pcm_bytes)))
    sys.stdout.buffer.write(pcm_bytes)
    sys.stdout.buffer.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Input text file")
    parser.add_argument("--voice", default=None)
    parser.add_argument("--speed", type=float, default=None)
    parser.add_argument("--lang", default=None)
    parser.add_argument("--speed-file", default=None, help="Path to file for dynamic speed updates")
    args = parser.parse_args()

    config = load_config()
    voice = args.voice or resolve_voice(config)
    speed = args.speed if args.speed is not None else config.get("speed", 1.0)
    lang_code = args.lang or config.get("language", "a")
    sample_rate = config.get("sample_rate", 24000)
    max_chars = config.get("chunk_max_chars", 400)
    inter_chunk = config.get("inter_chunk_silence", 0.3)

    progress("Loading Kokoro...", {"voice": voice, "speed": speed, "sample_rate": sample_rate})

    text = Path(args.input).read_text(encoding="utf-8")
    cleaned = clean_markdown_for_tts(text)

    if not cleaned.strip():
        progress("Error: no text to speak", {"error": True})
        sys.exit(1)

    chunks = split_into_chunks(cleaned, max_chars)
    progress(f"Streaming {len(chunks)} chunks with voice {voice}...",
             {"total_chunks": len(chunks), "voice": voice, "streaming": True})

    from kokoro import KPipeline
    pipeline = KPipeline(lang_code=lang_code)

    silence = np.zeros(int(inter_chunk * sample_rate), dtype=np.float32)
    start_time = time.time()
    total_audio_secs = 0.0

    speed_file = Path(args.speed_file) if args.speed_file else None

    for i, chunk in enumerate(chunks):
        # Check speed file for dynamic speed updates
        if speed_file and speed_file.exists():
            try:
                new_speed = float(speed_file.read_text().strip())
                if 0.5 <= new_speed <= 2.0 and abs(new_speed - speed) > 0.001:
                    speed = new_speed
                    progress(f"Speed changed to {speed:.2f}x", {"speed": speed})
            except (ValueError, OSError):
                pass

        chunk_parts = []
        for _gs, _ps, audio in pipeline(chunk, voice=voice, speed=speed):
            if audio is not None:
                chunk_parts.append(audio)

        if chunk_parts:
            chunk_audio = np.concatenate(chunk_parts)
            combined = np.concatenate([chunk_audio, silence])
            write_audio_chunk(combined)
            total_audio_secs += len(combined) / sample_rate

        progress(f"Chunk {i+1}/{len(chunks)}",
                 {"chunk": i + 1, "total_chunks": len(chunks),
                  "percent": round((i + 1) / len(chunks) * 100),
                  "chunk_text": chunk[:150]})

    elapsed = time.time() - start_time
    progress(f"Done: {total_audio_secs:.1f}s audio in {elapsed:.1f}s",
             {"done": True, "duration": round(total_audio_secs, 1)})


if __name__ == "__main__":
    main()
