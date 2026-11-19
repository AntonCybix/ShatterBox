# Installerar (eller återskapar) Python-miljön för talsyntesen OmniVoice.
# Körs av "shatterbox setup". Behövs bara om mappen .venv-omnivoice saknas eller har gått sönder.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-tts.ps1 [-Backend auto|rocm|cuda|cpu]
#
#   rocm  AMD Radeon RX 7000/9000-serien, drivrutin Adrenalin 26.2.2 eller nyare
#   cuda  NVIDIA
#   cpu   inget grafikkort (fungerar, men talet tar längre tid att skapa)
#   auto  väljer efter vilket grafikkort som sitter i datorn
#
# Allt hamnar under projektmappen (tools\ och .venv-omnivoice\), inget i din användarmapp.

param([ValidateSet('auto', 'rocm', 'cuda', 'cpu')][string]$Backend = 'auto')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root 'tools'
$uv = Join-Path $tools 'uv\uv.exe'
$venv = Join-Path $root '.venv-omnivoice'
$python = Join-Path $venv 'Scripts\python.exe'

if ($Backend -eq 'auto') {
    $cards = (Get-CimInstance Win32_VideoController).Name -join ' '
    $Backend = if ($cards -match 'NVIDIA|GeForce|RTX|GTX') { 'cuda' } elseif ($cards -match 'Radeon|AMD') { 'rocm' } else { 'cpu' }
    Write-Host "Grafikkort: $cards"
}
Write-Host "Variant: $Backend"

$env:UV_CACHE_DIR = Join-Path $tools 'uv-cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $tools 'python'
$env:UV_LINK_MODE = 'hardlink'

function Invoke-Uv {
    & $uv @args
    if ($LASTEXITCODE -ne 0) { throw "uv misslyckades (kod $LASTEXITCODE)." }
}

if (-not (Test-Path $uv)) {
    Write-Host 'Hämtar uv (pakethanterare) ...'
    New-Item -ItemType Directory -Force (Split-Path $uv) | Out-Null
    $zip = Join-Path $tools 'uv.zip'
    Invoke-WebRequest -UseBasicParsing 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath (Split-Path $uv) -Force
    Remove-Item $zip
}

Write-Host 'Skapar Python 3.12-miljö ...'
Invoke-Uv venv $venv --python 3.12

$packages = 'omnivoice', 'soundfile', 'fastapi', 'uvicorn', 'imageio-ffmpeg', 'setuptools<81'

if ($Backend -eq 'rocm') {
    # AMD:s officiella PyTorch för Windows (ROCm). Se:
    # https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/install/installrad/windows/install-pytorch.html
    $rocm = 'https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1'
    Write-Host 'Installerar ROCm och PyTorch (flera GB) ...'
    Invoke-Uv pip install --python $python `
        "$rocm/rocm_sdk_core-7.2.1-py3-none-win_amd64.whl" `
        "$rocm/rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl" `
        "$rocm/rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl" `
        "$rocm/rocm-7.2.1.tar.gz" `
        "$rocm/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl" `
        "$rocm/torchaudio-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl"

    # Lås PyTorch-versionen så att övriga paket inte byter ut ROCm-bygget mot ett utan GPU-stöd.
    $constraints = Join-Path $tools 'torch-constraints.txt'
    Set-Content -Path $constraints -Value "torch==2.9.1+rocm7.2.1`ntorchaudio==2.9.1+rocm7.2.1"
    Write-Host 'Installerar OmniVoice ...'
    Invoke-Uv pip install --python $python --constraint $constraints @packages
} else {
    # uv väljer rätt PyTorch-bygge: "auto" läser av NVIDIA-drivrutinen, "cpu" tar bygget utan GPU.
    $torchBackend = if ($Backend -eq 'cuda') { 'auto' } else { 'cpu' }
    Write-Host 'Installerar PyTorch och OmniVoice (flera GB) ...'
    Invoke-Uv pip install --python $python --torch-backend $torchBackend torch torchaudio @packages
}

Write-Host 'Kontrollerar ...'
& $python -c "import torch; print('PyTorch', torch.__version__); print('Grafikkort:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'inget - talsyntesen körs på processorn')"
if ($LASTEXITCODE -ne 0) { throw 'PyTorch gick inte att starta.' }
