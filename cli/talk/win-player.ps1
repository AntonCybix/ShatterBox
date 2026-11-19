# Spelar upp WAV-filer i tur och ordning åt "shatterbox talk" i Windows.
# Styrs via stdin, en rad per klipp:  play <id> <sökvägen som base64>
# Svarar på stdout:  ready, start <id>, end <id>, error <id> <text>
# Uppspelningen avbryts genom att processen avslutas.

$player = New-Object System.Media.SoundPlayer
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
    if (-not $line.StartsWith('play ')) { continue }
    $parts = $line.Split(' ')
    $id = $parts[1]
    try {
        $player.SoundLocation = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[2]))
        $player.Load()
        [Console]::Out.WriteLine("start $id")
        $player.PlaySync()
    } catch {
        [Console]::Out.WriteLine("error $id $($_.Exception.Message)")
    }
    [Console]::Out.WriteLine("end $id")
}
