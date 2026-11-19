#!/usr/bin/env bash
# Startar allt i Linux: Ollama, talsyntesen och containrarna. Motsvarar scripts/start.ps1.
# Körs av "./shatterbox start".
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
logs="$root/logs"
mkdir -p "$logs"
# I Linux delar Discord-boten värdens nätverk, se docker-compose.linux.yml.
export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml:docker-compose.linux.yml}"

up() { curl -fs -o /dev/null --max-time 3 "$1"; }
wait_for() { # adress, sekunder, namn
  local deadline=$((SECONDS + $2))
  while [ $SECONDS -lt $deadline ]; do
    up "$1" && return 0
    sleep 2
  done
  echo "  VARNING: $3 svarade inte inom $2 s" >&2
  return 1
}

echo "1/3 Ollama"
if ! up http://127.0.0.1:11434/api/version; then
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files ollama.service >/dev/null 2>&1 \
     && (systemctl start ollama 2>/dev/null || sudo -n systemctl start ollama 2>/dev/null); then
    :
  elif command -v ollama >/dev/null 2>&1; then
    nohup ollama serve >"$logs/ollama.log" 2>&1 &
  else
    echo "  Ollama är inte installerat. Kör ./shatterbox setup" >&2
  fi
  wait_for http://127.0.0.1:11434/api/version 60 Ollama || true
fi

echo "2/3 Talsyntes"
pidfile="$logs/tts-gpu.pid"
if [ ! -x "$root/.venv-omnivoice/bin/python" ]; then
  echo "  Talsyntesen är inte installerad (kör ./shatterbox setup). Karaktärerna svarar bara i text."
elif ! up http://127.0.0.1:8003/health && ! { [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }; then
  nohup "$root/scripts/tts.sh" >"$logs/tts-gpu.log" 2>&1 &
  echo $! >"$pidfile"
fi

echo "3/3 docker compose up"
if ! docker info >/dev/null 2>&1; then
  echo "  Docker är inte igång. Starta det (sudo systemctl start docker) och försök igen." >&2
  exit 1
fi
# Sökmotorns inställningar skapas första gången, med en hemlig nyckel som bara finns här.
if [ ! -f "$root/searxng/settings.yml" ]; then
  key="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed "s/__SECRET_KEY__/$key/" "$root/searxng/settings.example.yml" > "$root/searxng/settings.yml"
fi
docker compose up -d || { echo "  docker compose misslyckades (se ovan)." >&2; exit 1; }

if [ -x "$root/.venv-omnivoice/bin/python" ]; then
  echo
  echo "Väntar på att talsyntesen ska ladda modellen ..."
  wait_for http://127.0.0.1:8003/health 300 Talsyntesen || echo "  Se loggen: $logs/tts-gpu.log"
fi

echo
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
echo
echo "Allt är igång. Prata: ./shatterbox talk     Läge: ./shatterbox status     Stoppa: ./shatterbox stop"
