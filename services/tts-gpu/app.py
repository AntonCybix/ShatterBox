"""Talsyntes med röstkloning: OmniVoice (k2-fsa) på grafikkortet, eller på processorn om inget finns.

Körs direkt på datorn, inte i Docker (Docker på Windows kommer inte åt AMD-kort).
Startas av scripts/tts-gpu.ps1 (Windows) eller scripts/tts.sh (Linux), som sätter alla sökvägar.
Grafikkort: AMD via ROCm eller NVIDIA via CUDA. TTS_DEVICE=cpu tvingar fram processorn.

Röster - varje bot/karaktär kan ha sin egen. I den här ordningen:
  1. Röstprov i mappen voice:  voice/<röstnamn>.wav (eller m4a, mp3 ...). Första botens
     röstnamn är "reference". De första ~10 sekunderna används. Texten läses av automatiskt;
     vill du ange den själv, lägg <röstnamn>.txt bredvid (då används hela inspelningen).
  2. Designad röst utifrån en beskrivning (voice_style), t.ex. "male, elderly, low pitch, british accent".
  3. En fast standardröst per språk.
Röstprov läses om automatiskt när filen ändras.

POST /speak  {"text": "...", "language": "sv", "voice": "reference", "voice_style": null, "sr": 48000}
             ->  audio/wav (mono, 16-bit), svarshuvudet X-Voice talar om vilken röst som användes
GET  /health
"""
import difflib
import hashlib
import io
import json
import logging
import os
import re
import subprocess
import threading
import time
import urllib.parse
import urllib.request
import wave
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio.functional as AF

# AMD:s faltningsbibliotek (MIOpen) letar ny lösning för varje ny ljudlängd, vilket tar
# flera sekunder per mening. PyTorchs egna faltningar är snabbare för det här. Gäller bara
# ROCm-bygget; på NVIDIA ska cuDNN vara kvar.
if "rocm" in torch.__version__:
    torch.backends.cudnn.enabled = False

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.concurrency import run_in_threadpool  # noqa: E402
from fastapi.responses import Response  # noqa: E402
from omnivoice import OmniVoice  # noqa: E402
from pydantic import BaseModel  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("tts-gpu")

MODEL_ID = os.getenv("TTS_MODEL", "k2-fsa/OmniVoice")
LANGUAGE = os.getenv("TTS_LANGUAGE", "sv")
STEPS = int(os.getenv("TTS_STEPS", "16"))  # 16 = snabbt, 32 = något högre kvalitet men dubbla tiden
SPEED = float(os.getenv("TTS_SPEED", "1.0"))
REF_SECONDS = float(os.getenv("TTS_REF_SECONDS", "10"))
# Tempokompensation för röstprov med lite tal (tecken per sekund), se _tempo_fix
MIN_REF_RATE = float(os.getenv("TTS_MIN_REF_RATE", "9"))
TARGET_RATE = float(os.getenv("TTS_TARGET_RATE", "11"))
MAX_TEMPO_FIX = 3.0
VOICE_DIR = Path(os.getenv("VOICE_DIR", "voice"))
STATE_DIR = Path(os.getenv("TTS_STATE_DIR", "tts-state"))
STT_URL = os.getenv("STT_URL", "http://127.0.0.1:8001")
AUDIO_EXT = {".wav", ".m4a", ".mp3", ".flac", ".ogg", ".opus", ".aac", ".wma", ".webm", ".mp4"}
DEFAULT_VOICE_NAMES = ("reference", "referens", "voice", "min_rost")
SAMPLE_TEXT = {
    "sv": "Hej! Jag är din röstassistent. Fråga mig vad du vill, så gör jag mitt bästa för att hjälpa dig.",
    "en": "Hello there! I am your voice assistant. Ask me anything you like, and I will do my best to help you.",
}

USE_GPU = torch.cuda.is_available() and os.getenv("TTS_DEVICE", "").lower() != "cpu"
if os.getenv("TTS_DEVICE", "").lower() in ("cuda", "gpu") and not USE_GPU:
    raise SystemExit("TTS_DEVICE kräver ett grafikkort, men PyTorch hittar inget. Är drivrutinen uppdaterad?")
STATE_DIR.mkdir(parents=True, exist_ok=True)
_legacy_default = STATE_DIR / "default-voice.wav"
if _legacy_default.exists() and not (STATE_DIR / "default-voice-sv.wav").exists():
    _legacy_default.rename(STATE_DIR / "default-voice-sv.wav")

_t0 = time.time()
GPU = torch.cuda.get_device_name(0) if USE_GPU else "CPU"
log.info("laddar %s på %s ...", MODEL_ID, GPU)
if USE_GPU:
    model = OmniVoice.from_pretrained(MODEL_ID, device_map="cuda:0", dtype=torch.float16)
else:
    log.warning("inget grafikkort: talsyntesen körs på processorn och blir märkbart långsammare")
    model = OmniVoice.from_pretrained(MODEL_ID, device_map="cpu", dtype=torch.float32)
SR = int(model.sampling_rate)
log.info("modellen klar efter %.1f s (sr=%d)", time.time() - _t0, SR)

_lock = threading.Lock()
_voices: dict[str, dict] = {}  # nyckel -> {"sig", "prompt", "label", "text"}
_retry_after: dict[str, float] = {}  # röstprov som nyss misslyckades: vänta innan nytt försök


def _ffmpeg() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def _sample_text(language: str) -> str:
    return SAMPLE_TEXT.get(language, SAMPLE_TEXT["en"])


def _generate(text: str, language: str, prompt=None, instruct: str | None = None,
              steps: int = STEPS, speed: float = SPEED) -> np.ndarray:
    kwargs = {"text": text, "language": language, "num_step": steps, "speed": speed}
    if prompt is not None:
        kwargs["voice_clone_prompt"] = prompt
    if instruct:
        kwargs["instruct"] = instruct
    # Siffror skrivs ut som ord av boten innan texten kommer hit (OmniVoice egen
    # textnormalisering kräver ett bibliotek som inte finns för Windows).
    audio = model.generate(**kwargs)
    if USE_GPU:
        torch.cuda.synchronize()
    return np.asarray(audio[0], dtype=np.float32)


def _says(wav: Path, text: str, language: str) -> bool | None:
    """Säger klippet det det ska? None om det inte går att kontrollera (tal-till-text nere)."""
    try:
        heard = _transcribe(wav, language)
    except Exception:
        return None
    expected = re.findall(r"\w+", text.lower())
    got = re.findall(r"\w+", heard.lower())
    return difflib.SequenceMatcher(None, expected, got).ratio() >= 0.75


def _prompt_from_generated(wav: Path, language: str, instruct: str | None = None):
    """En syntetisk röst skapas en gång, sparas och klonas sedan, så att den låter likadant varje gång.

    Röstdesign är slumpmässig och ger ibland bara brus, så varje försök kontrolleras med
    tal-till-text innan det sparas.
    """
    text = _sample_text(language)
    if not wav.exists():
        draft = wav.with_suffix(".draft.wav")
        for attempt in range(1, 7):
            sf.write(str(draft), _generate(text, language, instruct=instruct, steps=32), SR)
            verdict = _says(draft, text, language)
            if verdict is not False:
                if verdict is None:
                    log.warning("kunde inte kontrollera den nya rösten (tal-till-text svarar inte)")
                draft.replace(wav)
                break
            log.info("försök %d gav inget begripligt tal - provar igen", attempt)
        else:
            draft.unlink(missing_ok=True)
            raise ValueError("fick inget begripligt tal med den röstbeskrivningen - prova färre eller andra ord")
    return model.create_voice_clone_prompt(ref_audio=str(wav), ref_text=text)


def _find_reference(name: str | None) -> Path | None:
    """voice/<namn>.<ljudformat>. Dubbla ändelser som reference.m4a.wav godtas också."""
    if not VOICE_DIR.is_dir():
        return None
    wanted = (name.lower(),) if name else DEFAULT_VOICE_NAMES
    files = sorted(
        p for p in VOICE_DIR.iterdir()
        if p.is_file() and p.suffix.lower() in AUDIO_EXT and p.name.lower().split(".")[0] in wanted
    )
    return files[0] if files else None


def _transcribe(clip: Path, language: str) -> str:
    request = urllib.request.Request(
        f"{STT_URL}/transcribe?language={urllib.parse.quote(language)}",
        data=clip.read_bytes(),
        headers={"Content-Type": "audio/wav"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8")).get("text", "").strip()


def _transcript_file(ref: Path) -> Path:
    """reference.wav -> reference.txt (även reference.m4a.wav -> reference.txt)."""
    return ref.with_name(ref.name.split(".")[0] + ".txt")


def _prompt_from_recording(ref: Path, language: str):
    transcript_file = _transcript_file(ref)
    has_transcript = transcript_file.exists()
    clip = STATE_DIR / f"clip-{ref.name.lower().split('.')[0]}.wav"
    command = [
        _ffmpeg(), "-y", "-loglevel", "error", "-i", str(ref), "-ac", "1", "-ar", str(SR),
        "-af", "highpass=f=60,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.1",
    ]
    if not has_transcript:
        command += ["-t", str(REF_SECONDS)]  # egen text gäller hela inspelningen, annars klipper vi
    subprocess.run(command + [str(clip)], check=True)

    seconds = sf.info(str(clip)).duration
    if seconds < 3:
        raise ValueError(f"röstprovet är bara {seconds:.1f} s - spela in minst 5-10 sekunder tal")
    text = transcript_file.read_text(encoding="utf-8-sig").strip() if has_transcript else _transcribe(clip, language)
    if len(text) < 5:
        raise ValueError("hörde inget tal i röstprovet")
    return model.create_voice_clone_prompt(ref_audio=str(clip), ref_text=text), text, seconds


def _tempo_fix(text: str, seconds: float) -> float:
    """Hur mycket talet behöver snabbas upp för ett röstprov med lite tal i.

    OmniVoice härmar provets tempo: tecken per sekund. Ett prov med långa pauser, musik eller
    ljudeffekter (eller där bara några ord uppfattats) ser ut som extremt långsamt tal, och då
    dras varje mening ut till 10-15 sekunder. Normalt tal ligger runt 12-16 tecken per sekund.
    """
    rate = len(text) / max(seconds, 0.1)
    if rate >= MIN_REF_RATE:
        return 1.0
    return min(MAX_TEMPO_FIX, TARGET_RATE / max(rate, 1.0))


def _voice_for(name: str | None, style: str | None, language: str) -> dict:
    """Väljer röst enligt ordningen i modulbeskrivningen. Anropas med låset taget."""
    # 1. Inspelat röstprov
    ref = _find_reference(name)
    if ref is not None:
        key = f"file:{ref.name.lower()}"
        transcript = _transcript_file(ref)
        sig = (ref.stat().st_mtime, transcript.stat().st_mtime if transcript.exists() else 0, language)
        cached = _voices.get(key)
        if cached and cached["sig"] == sig:
            return cached
        if time.time() >= _retry_after.get(key, 0):
            try:
                t = time.time()
                prompt, text, seconds = _prompt_from_recording(ref, language)
                tempo = _tempo_fix(text, seconds)
                _voices[key] = {"sig": sig, "prompt": prompt, "label": ref.name, "text": text, "tempo": tempo}
                log.info("röstprov inläst: %s (%.1f s ljud, %.1f s) - text: %r", ref.name, seconds, time.time() - t, text)
                if tempo > 1.0:
                    log.warning(
                        "röstprovet %s innehåller lite tal (%.1f tecken/s) - snabbar upp talet %.1f gånger. "
                        "Ett prov med 10 s sammanhängande tal utan pauser och musik ger bättre resultat.",
                        ref.name, len(text) / seconds, tempo,
                    )
                return _voices[key]
            except Exception as exc:
                # T.ex. om tal-till-text inte har startat än: försök igen om en stund.
                log.warning("kunde inte läsa röstprovet %s (%s) - försöker igen om 30 s", ref.name, exc)
                _retry_after[key] = time.time() + 30

    # 2. Designad röst
    style = (style or "").strip().lower()
    if style:
        key = f"style:{language}:{style}"
        if key in _voices:
            return _voices[key]
        if time.time() >= _retry_after.get(key, 0):
            slug = re.sub(r"[^a-z0-9]+", "-", style).strip("-")[:40]
            digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:8]
            try:
                log.info("skapar designad röst: %s (%s) ...", style, language)
                prompt = _prompt_from_generated(STATE_DIR / f"designed-{language}-{slug}-{digest}.wav", language, style)
                _voices[key] = {"sig": None, "prompt": prompt, "label": f"designad: {style}", "text": ""}
                return _voices[key]
            except Exception as exc:
                log.warning("kunde inte skapa rösten %r: %s", style, str(exc).splitlines()[0][:300])
                _retry_after[key] = time.time() + 300

    # 3. Standardröst för språket
    key = f"default:{language}"
    if key not in _voices:
        log.info("förbereder standardröst (%s) ...", language)
        prompt = _prompt_from_generated(STATE_DIR / f"default-voice-{language}.wav", language)
        _voices[key] = {"sig": None, "prompt": prompt, "label": f"standardröst ({language})", "text": ""}
    return _voices[key]


with _lock:
    _voice = _voice_for(None, None, LANGUAGE)
    _t = time.time()
    _generate("Hej, nu är jag igång.", LANGUAGE, _voice["prompt"])  # värmer upp, första körningen är långsam
    log.info("uppvärmd på %.1f s, röst: %s", time.time() - _t, _voice["label"])

app = FastAPI(title="tts-gpu")


class SpeakRequest(BaseModel):
    text: str
    language: str | None = None
    voice: str | None = None
    voice_style: str | None = None
    sr: int | None = None
    steps: int | None = None
    speed: float | None = None


@app.get("/health")
def health():
    return {
        "ready": True,
        "engine": MODEL_ID,
        "device": GPU,
        "language": LANGUAGE,
        "voices": {key: {"label": v["label"], "text": v["text"]} for key, v in _voices.items()},
        "steps": STEPS,
        "sample_rate": SR,
    }


def _synthesize(req: SpeakRequest):
    text = req.text.strip()
    language = (req.language or LANGUAGE).strip().lower()
    with _lock:
        voice = _voice_for(req.voice, req.voice_style, language)
        t = time.time()
        speed = (req.speed or SPEED) * voice.get("tempo", 1.0)
        samples = _generate(text, language, voice["prompt"], steps=req.steps or STEPS, speed=speed)
        gen_seconds = time.time() - t
        label = voice["label"]

    wav = torch.from_numpy(samples).unsqueeze(0)
    sr = SR
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
        "%.1f s tal på %.1f s (RTF %.2f, %s, %s): %r",
        audio_seconds, gen_seconds, gen_seconds / max(audio_seconds, 1e-6), language, label, text[:80],
    )
    return buf.getvalue(), gen_seconds, audio_seconds, label


@app.post("/speak")
async def speak(req: SpeakRequest):
    if not req.text.strip():
        raise HTTPException(400, "tom text")
    try:
        data, gen_seconds, audio_seconds, label = await run_in_threadpool(_synthesize, req)
    except Exception as exc:
        log.exception("syntes misslyckades")
        raise HTTPException(500, f"syntes misslyckades: {exc}") from exc
    return Response(
        content=data,
        media_type="audio/wav",
        headers={
            "X-Gen-Seconds": f"{gen_seconds:.2f}",
            "X-Audio-Seconds": f"{audio_seconds:.2f}",
            "X-Voice": urllib.parse.quote(label),
        },
    )
