#!/usr/bin/env bash
# Stoppar containrarna och talsyntesen i Linux. Ollama lämnas igång (den används ofta av annat).
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml:docker-compose.linux.yml}"

echo "Stoppar containrarna ..."
docker compose --profile cpu down

echo "Stoppar talsyntesen ..."
pidfile="$root/logs/tts-gpu.pid"
if [ -f "$pidfile" ]; then
  kill "$(cat "$pidfile")" 2>/dev/null || true
  rm -f "$pidfile"
fi
# Säkerhetsbälte: om processen startats för hand
pkill -f "uvicorn app:app --app-dir $root/services/tts-gpu" 2>/dev/null || true

echo "Klart."
