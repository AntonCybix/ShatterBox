#!/usr/bin/env bash
# Installerar ShatterBox i Linux: ser till att Node.js finns och lämnar sedan över till
# installationsguiden (./shatterbox setup), som sköter resten.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"
chmod +x shatterbox scripts/*.sh 2>/dev/null || true

need_node() {
  cat >&2 <<'EOF'
Node.js 18 eller nyare behövs för kommandot shatterbox och kontrollpanelen.

  Debian/Ubuntu:   sudo apt install nodejs
  Fedora:          sudo dnf install nodejs
  Arch:            sudo pacman -S nodejs
  Andra system:    https://nodejs.org/en/download

Kör sedan ./setup.sh igen.
EOF
  exit 1
}

command -v node >/dev/null 2>&1 || need_node
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 18 ]; then
  echo "Den installerade Node.js är för gammal (v$(node -p process.versions.node))." >&2
  need_node
fi
command -v curl >/dev/null 2>&1 || echo "Obs: curl saknas och behövs av startskripten (sudo apt install curl)." >&2

exec node "$root/cli/shatterbox.mjs" setup
