"""Tal-till-text med faster-whisper på CPU.

Svenska görs med KB-Whisper, övriga språk med flerspråkiga Whisper. Om flera språk är
möjliga (karaktärer med olika språk) avgörs språket först av den flerspråkiga modellen.
Varje modell körs i en egen process, se worker.py.

POST /transcribe?language=sv            -> tvinga ett språk
POST /transcribe?languages=sv,en        -> känn av vilket av språken som talas
  - Content-Type: audio/pcm  -> rå PCM, 16 kHz, mono, signed 16-bit little endian
  - annars                   -> en 16-bitars WAV-fil
  Svar: {"text": "...", "language": "sv", "audio_seconds": 3.2, "seconds": 0.4, ...}
POST /preload?languages=sv,en           -> ladda modellerna i förväg (i bakgrunden)
"""
import io
import logging
import multiprocessing
import os
import threading
import time
import wave
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

import worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("stt")

DEFAULT_LANGUAGE = os.getenv("STT_LANGUAGE", "sv")
COMPUTE_TYPE = os.getenv("STT_COMPUTE_TYPE", "int8")
THREADS = int(os.getenv("STT_THREADS", "8"))
BEAM_SIZE = int(os.getenv("STT_BEAM_SIZE", "5"))
MULTILINGUAL = "small"  # flerspråkig Whisper: övriga språk och språkval
DETECT_MODEL = os.getenv("STT_DETECT_MODEL", "").strip() or MULTILINGUAL
# Ord som ofta hörs fel (spelnamn, egennamn), kommaseparerade. Tomt = av.
HOTWORDS = os.getenv("STT_HOTWORDS", "").strip() or None

BUILTIN_MODELS = {"sv": "KBLab/kb-whisper-small"}


def model_id_for(language: str) -> str:
    """STT_MODEL_<SPRÅK> > STT_MODEL (för standardspråket) > inbyggt val > flerspråkig modell."""
    specific = os.getenv(f"STT_MODEL_{language.upper()}", "").strip()
    if specific:
        return specific
    if language == DEFAULT_LANGUAGE and os.getenv("STT_MODEL", "").strip():
        return os.environ["STT_MODEL"].strip()
    return BUILTIN_MODELS.get(language, MULTILINGUAL)


class ModelProcess:
    """En modell i en barnprocess. Ett anrop i taget."""

    _context = multiprocessing.get_context("spawn")

    def __init__(self, model_id: str):
        self.model_id = model_id
        self.lock = threading.Lock()
        t = time.time()
        log.info("laddar %s (%s, %d trådar) ...", model_id, COMPUTE_TYPE, THREADS)
        self.conn, child = self._context.Pipe()
        self.process = self._context.Process(
            target=worker.serve, args=(model_id, COMPUTE_TYPE, THREADS, child), daemon=True
        )
        self.process.start()
        child.close()
        status, payload = self.conn.recv()
        if status != "ok":
            raise RuntimeError(payload)
        log.info("%s klar efter %.1f s", model_id, time.time() - t)

    def alive(self) -> bool:
        return self.process.is_alive()

    def call(self, kind: str, audio: np.ndarray, **kwargs):
        with self.lock:
            self.conn.send((kind, audio, kwargs))
            status, payload = self.conn.recv()
        if status != "ok":
            raise RuntimeError(payload)
        return payload


_models: dict[str, ModelProcess] = {}
_load_lock = threading.Lock()


def get_model(model_id: str) -> ModelProcess:
    model = _models.get(model_id)
    if model is None or not model.alive():
        with _load_lock:
            model = _models.get(model_id)
            if model is None or not model.alive():
                model = ModelProcess(model_id)
                _models[model_id] = model
    return model


@asynccontextmanager
async def lifespan(_app):
    await run_in_threadpool(get_model, model_id_for(DEFAULT_LANGUAGE))
    yield


app = FastAPI(title="stt", lifespan=lifespan)


def _parse_languages(language: str | None, languages: str | None) -> list[str]:
    if language:
        return [language.strip().lower()]
    found = []
    for item in (languages or "").split(","):
        item = item.strip().lower()
        if item and item not in found:
            found.append(item)
    return found or [DEFAULT_LANGUAGE]


@app.get("/health")
def health():
    return {
        "ready": True,
        "language": DEFAULT_LANGUAGE,
        "model": model_id_for(DEFAULT_LANGUAGE),
        "loaded": sorted(name for name, model in _models.items() if model.alive()),
    }


@app.post("/preload")
def preload(languages: str | None = None):
    wanted = _parse_languages(None, languages)
    ids = [model_id_for(lang) for lang in wanted]
    if len(wanted) > 1:
        ids.append(DETECT_MODEL)
    ids = list(dict.fromkeys(ids))

    def load():
        for model_id in ids:
            try:
                get_model(model_id)
            except Exception:
                log.exception("kunde inte ladda %s", model_id)

    threading.Thread(target=load, daemon=True).start()
    return {"loading": ids}


def _decode_wav(body: bytes) -> np.ndarray:
    """16-bitars WAV -> float32, mono, 16 kHz."""
    with wave.open(io.BytesIO(body)) as w:
        channels, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise ValueError(f"WAV med {width * 8} bitar stöds inte")
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != 16000 and len(samples):
        target = int(round(len(samples) * 16000 / rate))
        samples = np.interp(
            np.linspace(0, len(samples) - 1, target), np.arange(len(samples)), samples
        ).astype(np.float32)
    return samples


def _detect(audio: np.ndarray, candidates: list[str]) -> tuple[str, dict[str, float]]:
    """Väljer det troligaste av kandidatspråken."""
    try:
        probs = get_model(DETECT_MODEL).call("detect", audio)
    except Exception as exc:
        log.warning("språkvalet misslyckades (%s) - antar %s", exc, candidates[0])
        return candidates[0], {}
    scores = {c: float(probs.get(c, 0.0)) for c in candidates}
    # Svenska förväxlas ibland med norska/danska: räkna dem som svenska om de inte själva är kandidater.
    if "sv" in scores and not {"no", "nn", "da"} & set(candidates):
        scores["sv"] = max(scores["sv"], *(float(probs.get(x, 0.0)) for x in ("no", "nn", "da")))
    best = max(candidates, key=lambda c: scores[c])
    return best, {k: round(v, 3) for k, v in scores.items()}


def _transcribe(audio: np.ndarray, candidates: list[str], hotwords: str | None = None):
    t = time.time()
    hints = ", ".join(part for part in (HOTWORDS, (hotwords or "").strip()) if part) or None
    scores = {}
    language = candidates[0]
    if len(candidates) > 1:
        language, scores = _detect(audio, candidates)
    detect_seconds = time.time() - t

    result = get_model(model_id_for(language)).call(
        "transcribe",
        audio,
        language=language,
        beam_size=BEAM_SIZE,
        vad_filter=True,  # klipper bort tystnad, annars hittar Whisper gärna på text
        vad_parameters={"min_silence_duration_ms": 300},
        condition_on_previous_text=False,
        hotwords=hints,
    )
    took = time.time() - t
    log.info(
        "%.1f s ljud -> %.2f s (%s%s): %r",
        result["duration"], took, language,
        f", språkval {detect_seconds:.2f} s {scores}" if scores else "", result["text"],
    )
    return {
        "text": result["text"],
        "language": language,
        "language_scores": scores,
        "audio_seconds": round(result["duration"], 2),
        "speech_seconds": round(result["speech"], 2),
        "seconds": round(took, 2),
    }


@app.post("/transcribe")
async def transcribe(
    request: Request, language: str | None = None, languages: str | None = None, hotwords: str | None = None
):
    body = await request.body()
    if not body:
        raise HTTPException(400, "tom ljuddata")
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    try:
        if body[:4] == b"RIFF":
            audio = _decode_wav(body)
        elif ctype in ("audio/pcm", "audio/l16"):
            usable = len(body) // 2 * 2
            audio = np.frombuffer(body[:usable], dtype="<i2").astype(np.float32) / 32768.0
        else:
            raise ValueError("skicka rå PCM (Content-Type: audio/pcm) eller en 16-bitars WAV-fil")
        return await run_in_threadpool(_transcribe, audio, _parse_languages(language, languages), hotwords)
    except Exception as exc:
        log.exception("transkribering misslyckades")
        raise HTTPException(422, f"kunde inte transkribera: {exc}") from exc
