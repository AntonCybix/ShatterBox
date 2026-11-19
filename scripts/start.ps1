# Startar hela ShatterBox i ett svep:
#   1. Ollama (språkmodellen, på grafikkortet)
#   2. Docker Desktop
#   3. Talsyntesen (körs i Windows, se scripts\tts-gpu.ps1)
#   4. Resten via docker compose: sökmotor, tal-till-text och Discord-botarna
#
# Körs av "shatterbox start", kontrollpanelen och start.cmd.

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null

function Test-Url([string]$url) {
    try { Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 3 | Out-Null; return $true } catch { return $false }
}
function Test-Docker {
    cmd /c 'docker info >nul 2>&1'
    return $LASTEXITCODE -eq 0
}
function Wait-Until([scriptblock]$test, [int]$seconds, [string]$what) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (& $test) { return $true }
        Start-Sleep -Seconds 2
    }
    Write-Host "  VARNING: $what svarade inte inom $seconds s" -ForegroundColor Yellow
    return $false
}

Write-Host '1/4 Ollama'
if (-not (Test-Url 'http://127.0.0.1:11434/api/version')) {
    $ollamaApp = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe'
    if (Test-Path $ollamaApp) { Start-Process $ollamaApp -WindowStyle Hidden }
    else { Start-Process 'ollama' -ArgumentList 'serve' -WindowStyle Hidden }
    Wait-Until { Test-Url 'http://127.0.0.1:11434/api/version' } 60 'Ollama' | Out-Null
}

Write-Host '2/4 Docker Desktop'
if (-not (Test-Docker)) {
    $candidates = @()
    $dockerCli = (Get-Command docker -ErrorAction SilentlyContinue).Source
    if ($dockerCli) { $candidates += Join-Path (Split-Path (Split-Path (Split-Path $dockerCli))) 'Docker Desktop.exe' }
    $candidates += Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    $desktop = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $desktop) { Write-Host '  Hittar inte Docker Desktop - starta det för hand och kör start.cmd igen.' -ForegroundColor Red; exit 1 }
    Start-Process $desktop
    if (-not (Wait-Until { Test-Docker } 180 'Docker')) { exit 1 }
}

Write-Host '3/4 Talsyntes på grafikkortet'
$pidFile = Join-Path $logs 'tts-gpu.pid'
$running = $false
if (Test-Path $pidFile) {
    $running = [bool](Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue)
}
$ttsInstalled = Test-Path (Join-Path $root '.venv-omnivoice\Scripts\python.exe')
if (-not $ttsInstalled) {
    Write-Host '  Talsyntesen är inte installerad (kör shatterbox setup). Karaktärerna svarar bara i text.' -ForegroundColor Yellow
} elseif (-not $running -and -not (Test-Url 'http://127.0.0.1:8003/health')) {
    $launcher = Join-Path $root 'scripts\tts-gpu.ps1'
    $process = Start-Process powershell.exe -WindowStyle Hidden -PassThru `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$launcher`"" `
        -RedirectStandardOutput (Join-Path $logs 'tts-gpu.out.log') `
        -RedirectStandardError (Join-Path $logs 'tts-gpu.log')
    Set-Content -Path $pidFile -Value $process.Id
}

Write-Host '4/4 docker compose up'
# Sökmotorns inställningar skapas första gången, med en hemlig nyckel som bara finns här.
$searxSettings = Join-Path $root 'searxng\settings.yml'
if (-not (Test-Path $searxSettings)) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $key = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    $template = [IO.File]::ReadAllText((Join-Path $root 'searxng\settings.example.yml'))
    [IO.File]::WriteAllText($searxSettings, $template.Replace('__SECRET_KEY__', $key), (New-Object System.Text.UTF8Encoding $false))
}
cmd /c 'docker compose up -d 2>&1'
if ($LASTEXITCODE -ne 0) { Write-Host '  docker compose misslyckades (se ovan).' -ForegroundColor Red; exit 1 }

if ($ttsInstalled) {
    Write-Host ''
    Write-Host 'Väntar på att talsyntesen ska ladda modellen ...'
    if (Wait-Until { Test-Url 'http://127.0.0.1:8003/health' } 180 'Talsyntesen') {
        $health = Invoke-RestMethod 'http://127.0.0.1:8003/health'
        Write-Host ("  klar på {0}, steg: {1}" -f $health.device, $health.steps)
    } else {
        Write-Host "  Se loggen: $logs\tts-gpu.log" -ForegroundColor Yellow
    }
}

Write-Host ''
cmd /c 'docker compose ps --format "table {{.Service}}\t{{.Status}}"'
Write-Host ''
Write-Host 'Allt är igång. Prata: shatterbox talk     Läge: shatterbox status     Stoppa: shatterbox stop'
