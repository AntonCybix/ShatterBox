# Första steget i installationen på Windows: ser till att Node.js finns och lämnar sedan över
# till installationsguiden (shatterbox setup), som sköter resten.
# Körs av setup.cmd i projektmappen.

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Find-Node {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $default = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path $default) { return $default }
    return $null
}

$node = Find-Node
if (-not $node) {
    Write-Host 'Node.js saknas. Det behövs för kommandot shatterbox och kontrollpanelen.' -ForegroundColor Yellow
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        Write-Host 'Installera Node.js (LTS) från https://nodejs.org och kör sedan setup.cmd igen.'
        exit 1
    }
    $answer = Read-Host 'Installera Node.js nu med winget? (J/n)'
    if ($answer -and $answer -notmatch '^(j|ja|y|yes)$') {
        Write-Host 'Installera Node.js (LTS) från https://nodejs.org och kör sedan setup.cmd igen.'
        exit 1
    }
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    $node = Find-Node
    if (-not $node) {
        Write-Host 'Node.js är installerat men syns inte i det här fönstret. Öppna ett nytt fönster och kör setup.cmd igen.' -ForegroundColor Yellow
        exit 1
    }
}

& $node (Join-Path $root 'cli\shatterbox.mjs') setup
exit $LASTEXITCODE
