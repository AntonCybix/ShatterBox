# Stoppar röstassistenten: containrarna och talsyntesen på grafikkortet.
# Ollama och Docker Desktop lämnas igång (de används ofta av annat).

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host 'Stoppar containrarna ...'
cmd /c 'docker compose --profile cpu down 2>&1'

Write-Host 'Stoppar talsyntesen på grafikkortet ...'
$pidFile = Join-Path $root 'logs\tts-gpu.pid'
if (Test-Path $pidFile) {
    $id = [int](Get-Content $pidFile)
    if (Get-Process -Id $id -ErrorAction SilentlyContinue) { cmd /c "taskkill /PID $id /T /F >nul 2>&1" }
    Remove-Item $pidFile -Confirm:$false
}
# Säkerhetsbälte: om processen startats för hand
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -like '*services\tts-gpu*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }

Write-Host 'Klart.'
