#!/usr/bin/env bash
# Installerar (eller återskapar) Python-miljön för talsyntesen OmniVoice i Linux.
# Körs av "./shatterbox setup".
#
#   scripts/install-tts.sh [auto|cuda|rocm|cpu]
#
#   auto, cuda, rocm   uv läser av grafikkortet och väljer rätt PyTorch (NVIDIA eller AMD)
#   cpu                inget grafikkort (fungerar, men talet tar längre tid att skapa)
#
# Allt hamnar under projektmappen (tools/ och .venv-omnivoice/).
set -euo pipefail

backend="${1:-auto}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tools="$root/tools"
uv="$tools/uv/uv"
venv="$root/.venv-omnivoice"
python="$venv/bin/python"

case "$backend" in
  auto|cuda|rocm) torch_backend=auto ;;
  cpu) torch_backend=cpu ;;
  *) echo "Okänd variant: $backend (välj auto, cuda, rocm eller cpu)" >&2; exit 2 ;;
esac

export UV_CACHE_DIR="$tools/uv-cache"
export UV_PYTHON_INSTALL_DIR="$tools/python"

if [ ! -x "$uv" ]; then
  echo "Hämtar uv (pakethanterare) ..."
  case "$(uname -m)" in
    x86_64|amd64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) echo "Okänd processortyp: $(uname -m)" >&2; exit 1 ;;
  esac
  mkdir -p "$tools/uv"
  curl -fsSL "https://github.com/astral-sh/uv/releases/latest/download/uv-$arch-unknown-linux-gnu.tar.gz" \
    | tar -xz -C "$tools/uv" --strip-components=1
fi

echo "Skapar Python 3.12-miljö ..."
"$uv" venv "$venv" --python 3.12

echo "Installerar PyTorch och OmniVoice (flera GB) ..."
"$uv" pip install --python "$python" --torch-backend "$torch_backend" \
  torch torchaudio omnivoice soundfile fastapi uvicorn imageio-ffmpeg 'setuptools<81'

echo "Kontrollerar ..."
"$python" -c "import torch; print('PyTorch', torch.__version__); print('Grafikkort:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'inget - talsyntesen körs på processorn')"
