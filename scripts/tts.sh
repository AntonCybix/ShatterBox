#!/usr/bin/env bash
# Startar talsyntesen (OmniVoice) i Linux. Motsvarar scripts/tts-gpu.ps1.
# Startas normalt av scripts/start.sh; kör skriptet för hand om du vill se loggen direkt.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python="$root/.venv-omnivoice/bin/python"
if [ ! -x "$python" ]; then
  echo "Hittar inte $python - talsyntesen är inte installerad. Kör ./shatterbox setup" >&2
  exit 1
fi

# Inställningar från .env (LANGUAGE och TTS_*, utom TTS_URL som gäller boten)
if [ -f "$root/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[[:space:]]*(LANGUAGE|TTS_[A-Z_]+)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      value="${value%\'}"; value="${value#\'}"; value="${value%\"}"; value="${value#\"}"
      [ -z "$value" ] && continue
      [ "$key" = "TTS_URL" ] && continue
      [ "$key" = "LANGUAGE" ] && key=TTS_LANGUAGE
      export "$key=$value"
    fi
  done < "$root/.env"
fi

# Allt som laddas ner eller cachas hamnar i projektmappen.
export HF_HOME="$root/models/huggingface-host"
export TORCH_HOME="$root/models/torch"
export VOICE_DIR="$root/voice"
export TTS_STATE_DIR="$root/tools/tts-state"
export MIOPEN_USER_DB_PATH="$root/tools/miopen"
export MIOPEN_CUSTOM_CACHE_DIR="$root/tools/miopen"
export NUMBA_CACHE_DIR="$root/tools/numba"
export STT_URL="${STT_URL:-http://127.0.0.1:8001}"   # tal-till-text i Docker, läser av röstprov
export PYTHONUNBUFFERED=1
mkdir -p "$HF_HOME" "$TTS_STATE_DIR" "$MIOPEN_USER_DB_PATH" "$NUMBA_CACHE_DIR" "$VOICE_DIR"

exec "$python" -m uvicorn app:app --app-dir "$root/services/tts-gpu" \
  --host 127.0.0.1 --port "${TTS_GPU_PORT:-8003}" --no-access-log
