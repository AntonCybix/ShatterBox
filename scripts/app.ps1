# Öppnar kontrollpanelen för ShatterBox: startar den om den inte redan kör och visar den i ett
# eget fönster. Panelen startar sedan allt annat (Ollama, Docker, talsyntes, botar).
# Körs av skrivbordsgenvägen och "shatterbox ui". Skapa om genvägen med scripts\install-app.ps1.

$root = Split-Path -Parent $PSScriptRoot
$port = 8090
$url = "http://127.0.0.1:$port"
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null

function Test-Panel {
    try { Invoke-WebRequest -UseBasicParsing "$url/" -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}
function Show-Error([string]$message) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($message, 'ShatterBox', 'OK', 'Error') | Out-Null
}

if (-not (Test-Panel)) {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { Show-Error 'Node.js hittades inte. Installera Node.js från nodejs.org och försök igen.'; exit 1 }
    Start-Process $node -ArgumentList "`"$(Join-Path $root 'app\server.mjs')`"" -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logs 'app.log') -RedirectStandardError (Join-Path $logs 'app.err.log')
    $deadline = (Get-Date).AddSeconds(15)
    while (-not (Test-Panel) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    if (-not (Test-Panel)) { Show-Error "Appen kunde inte starta. Se $logs\app.err.log"; exit 1 }
}

# Eget fönster utan adressfält om Edge finns, annars en vanlig flik i standardwebbläsaren.
$target = "$url/?autostart=1"
$edge = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge) { Start-Process $edge -ArgumentList "--app=$target", '--window-size=1120,880' }
else { Start-Process $target }
