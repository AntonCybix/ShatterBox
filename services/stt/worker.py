"""En Whisper-modell i en egen process.

Varför egen process: trådbiblioteket (libgomp) som CTranslate2 använder slutar "snurra"
mellan beräkningsstegen så fort en process innehåller fler än en modell, och då blir varje
transkribering ungefär sex gånger långsammare. Med en process per modell går alla i full fart.

Den här modulen får inte ha sidoeffekter vid import - den laddas i barnprocessen.
"""


def serve(model_id: str, compute_type: str, threads: int, conn) -> None:
    from faster_whisper import WhisperModel

    try:
        model = WhisperModel(model_id, device="cpu", compute_type=compute_type, cpu_threads=threads)
    except Exception as exc:  # t.ex. nedladdningen misslyckades
        conn.send(("error", f"kunde inte ladda {model_id}: {exc!r}"))
        return
    conn.send(("ok", None))

    while True:
        try:
            job = conn.recv()
        except EOFError:
            return
        if job is None:
            return
        kind, audio, kwargs = job
        try:
            if kind == "detect":
                _, _, probs = model.detect_language(audio=audio, vad_filter=True)
                conn.send(("ok", dict(probs)))
            else:
                segments, info = model.transcribe(audio, **kwargs)
                text = " ".join(segment.text.strip() for segment in segments).strip()
                conn.send(
                    (
                        "ok",
                        {
                            "text": text,
                            "duration": float(info.duration),
                            "speech": float(getattr(info, "duration_after_vad", info.duration)),
                        },
                    )
                )
        except Exception as exc:
            conn.send(("error", repr(exc)))
