# Startar talsyntesen (OmniVoice) direkt i Windows, på grafikkortet om det finns ett.
#
# Docker på Windows kommer inte åt AMD-grafikkort, så just den här delen körs utanför Docker.
# Discord-botarna i Docker når den på http://host.docker.internal:8003.
# Startas normalt av "shatterbox start"; kör skriptet för hand om du vill se loggen i fönstret.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root '.venv-omnivoice\Scripts\python.exe'
if (-not (Test-Path $python)) { throw "Hittar inte $python - talsyntesen är inte installerad. Kör: shatterbox setup" }

# Inställningar från .env (LANGUAGE och TTS_*)
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile -Encoding UTF8) {
        if ($line -match '^\s*(LANGUAGE|TTS_[A-Z_]+)\s*=\s*(.*?)\s*$' -and $Matches[2] -ne '' -and $Matches[1] -ne 'TTS_URL') {
            $name = if ($Matches[1] -eq 'LANGUAGE') { 'TTS_LANGUAGE' } else { $Matches[1] }
            Set-Item -Path "Env:$name" -Value $Matches[2]
        }
    }
}

# Allt som laddas ner eller cachas hamnar på samma disk som projektet - inget på C:.
$env:HF_HOME = Join-Path $root 'models\huggingface-win'
$env:TORCH_HOME = Join-Path $root 'models\torch'
$env:VOICE_DIR = Join-Path $root 'voice'
$env:TTS_STATE_DIR = Join-Path $root 'tools\tts-state'
$env:MIOPEN_USER_DB_PATH = Join-Path $root 'tools\miopen'
$env:MIOPEN_CUSTOM_CACHE_DIR = Join-Path $root 'tools\miopen'
$env:NUMBA_CACHE_DIR = Join-Path $root 'tools\numba'
if (-not $env:STT_URL) { $env:STT_URL = 'http://127.0.0.1:8001' }   # tal-till-text i Docker, läser av röstprov
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
$env:PYTHONUTF8 = '1'
$env:PYTHONUNBUFFERED = '1'
foreach ($dir in $env:TTS_STATE_DIR, $env:MIOPEN_USER_DB_PATH, $env:NUMBA_CACHE_DIR, $env:VOICE_DIR) {
    New-Item -ItemType Directory -Force $dir | Out-Null
}

$port = if ($env:TTS_GPU_PORT) { $env:TTS_GPU_PORT } else { '8003' }
& $python -m uvicorn app:app --app-dir (Join-Path $root 'services\tts-gpu') --host 127.0.0.1 --port $port --no-access-log
