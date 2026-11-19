"""Text-till-tal med röstkloning: Chatterbox Multilingual.

Lägg en inspelning av din röst i /voice (mappen voice i projektet), t.ex. reference.wav
eller reference.m4a. Finns ingen fil används modellens standardröst. Filen läses om
automatiskt när den ändras - ingen omstart behövs.

POST /speak  {"text": "...", "language": "sv", "sr": 48000}  ->  audio/wav (mono, 16-bit)
GET  /health
"""
import inspect
import io
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
import wave
from pathlib import Path

import torch
import torchaudio.functional as AF
from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("tts")

DEVICE = os.getenv("TTS_DEVICE", "cpu")
LANGUAGE = os.getenv("TTS_LANGUAGE", "sv")
THREADS = int(os.getenv("TTS_THREADS", "8"))
EXAGGERATION = float(os.getenv("TTS_EXAGGERATION", "0.5"))
CFG_WEIGHT = float(os.getenv("TTS_CFG_WEIGHT", "0.5"))
TEMPERATURE = float(os.getenv("TTS_TEMPERATURE", "0.8"))
VOICE_DIR = Path(os.getenv("VOICE_DIR", "/voice"))
AUDIO_EXT = {".wav", ".m4a", ".mp3", ".flac", ".ogg", ".opus", ".aac", ".wma", ".webm", ".mp4"}
PREFERRED_NAMES = ("reference", "referens", "voice", "min_rost")
REF_WAV = str(Path(os.getenv("TTS_TMP", tempfile.gettempdir())) / "tts-reference.wav")

if DEVICE == "cpu":
    torch.set_num_threads(THREADS)
elif not torch.cuda.is_available():
    raise SystemExit(f"TTS_DEVICE={DEVICE} men PyTorch hittar inget grafikkort")


def _ffmpeg() -> str:
    """ffmpeg från PATH (Docker) eller det som följer med imageio-ffmpeg (Windows)."""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()

if DEVICE == "cpu":
    # Vikterna är sparade från GPU; tvinga dem till CPU vid inläsning.
    _orig_load = torch.load

    def _cpu_load(*args, **kwargs):
        kwargs.setdefault("map_location", "cpu")
        return _orig_load(*args, **kwargs)

    torch.load = _cpu_load

from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # noqa: E402

_t0 = time.time()
_where = torch.cuda.get_device_name(0) if DEVICE != "cpu" else f"CPU, {THREADS} trådar"
log.info("laddar Chatterbox Multilingual på %s ...", _where)
model = ChatterboxMultilingualTTS.from_pretrained(device=DEVICE)
log.info("modellen klar efter %.1f s (sr=%d)", time.time() - _t0, model.sr)

GEN_PARAMS = set(inspect.signature(model.generate).parameters)
DEFAULT_CONDS = getattr(model, "conds", None)

_gen_lock = threading.Lock()
_voice = {"path": None, "mtime": None, "label": "standardröst"}


def _find_reference() -> Path | None:
    if not VOICE_DIR.is_dir():
        return None
    files = sorted(p for p in VOICE_DIR.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXT)
    preferred = [p for p in files if p.stem.lower() in PREFERRED_NAMES]
    chosen = preferred or files
    return chosen[0] if chosen else None


def _prepare_voice() -> None:
    """Läser in röstprovet om det tillkommit eller ändrats. Anropas med _gen_lock taget."""
    ref = _find_reference()
    if ref is None:
        if _voice["path"] is not None and DEFAULT_CONDS is not None:
            model.conds = DEFAULT_CONDS
            _voice.update(path=None, mtime=None, label="standardröst")
            log.info("inget röstprov i %s - använder standardrösten", VOICE_DIR)
        return
    mtime = ref.stat().st_mtime
    if _voice["path"] == str(ref) and _voice["mtime"] == mtime:
        return
    # Modellen använder bara de första ~10 sekunderna: ta bort inledande tystnad,
    # gör mono och begränsa längden.
    subprocess.run(
        [
            _ffmpeg(), "-y", "-loglevel", "error", "-i", str(ref),
            "-ac", "1", "-ar", "24000",
            "-af", "highpass=f=60,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.1",
            "-t", "30", REF_WAV,
        ],
        check=True,
    )
    t = time.time()
    model.prepare_conditionals(REF_WAV, exaggeration=EXAGGERATION)
    _voice.update(path=str(ref), mtime=mtime, label=ref.name)
    log.info("röstprov inläst: %s (%.1f s)", ref.name, time.time() - t)


with _gen_lock:
    try:
        _prepare_voice()
    except Exception:
        log.exception("kunde inte läsa röstprovet - använder standardrösten")

app = FastAPI(title="tts")


class SpeakRequest(BaseModel):
    text: str
    language: str | None = None
    sr: int | None = None
    exaggeration: float | None = None
    cfg_weight: float | None = None
    temperature: float | None = None


@app.get("/health")
def health():
    return {
        "ready": True,
        "device": _where,
        "language": LANGUAGE,
        "voice": _voice["label"],
        "sample_rate": model.sr,
    }


def _synthesize(req: SpeakRequest):
    text = req.text.strip()
    with _gen_lock:
        try:
            _prepare_voice()
        except Exception:
            log.exception("kunde inte läsa röstprovet - behåller nuvarande röst")
        kwargs = {
            "language_id": req.language or LANGUAGE,
            "exaggeration": req.exaggeration if req.exaggeration is not None else EXAGGERATION,
            "cfg_weight": req.cfg_weight if req.cfg_weight is not None else CFG_WEIGHT,
            "temperature": req.temperature if req.temperature is not None else TEMPERATURE,
        }
        kwargs = {k: v for k, v in kwargs.items() if k in GEN_PARAMS}
        t = time.time()
        wav = model.generate(text, **kwargs)
        gen_seconds = time.time() - t
        voice = _voice["label"]

    wav = wav.detach().float().cpu()
    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    sr = model.sr
    if req.sr and req.sr != sr:
        wav = AF.resample(wav, sr, req.sr)
        sr = req.sr
    pcm = (wav[0].clamp(-1.0, 1.0) * 32767.0).to(torch.int16).numpy()

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    audio_seconds = len(pcm) / sr
    log.info(
        "%.1f s tal på %.1f s (RTF %.2f, %s): %r",
        audio_seconds, gen_seconds, gen_seconds / max(audio_seconds, 1e-6), voice, text[:80],
    )
    return buf.getvalue(), gen_seconds, audio_seconds, voice


@app.post("/speak")
async def speak(req: SpeakRequest):
    if not req.text.strip():
        raise HTTPException(400, "tom text")
    try:
        data, gen_seconds, audio_seconds, voice = await run_in_threadpool(_synthesize, req)
    except Exception as exc:
        log.exception("syntes misslyckades")
        raise HTTPException(500, f"syntes misslyckades: {exc}") from exc
    return Response(
        content=data,
        media_type="audio/wav",
        headers={
            "X-Gen-Seconds": f"{gen_seconds:.2f}",
            "X-Audio-Seconds": f"{audio_seconds:.2f}",
        },
    )
