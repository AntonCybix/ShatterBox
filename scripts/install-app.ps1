# Skapar appens ikon och genvägen "ShatterBox" på skrivbordet (och i projektmappen).
# Kör igen om genvägen försvunnit eller projektmappen har flyttats:
#   powershell -ExecutionPolicy Bypass -File scripts\install-app.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $root 'app'
Add-Type -AssemblyName System.Drawing

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

# Ikonen: en pratbubbla med ljudstaplar på turkos botten.
function New-IconBitmap([int]$size) {
    $bitmap = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $s = $size / 256.0
    $g.ScaleTransform($s, $s)

    $background = New-RoundedPath 8 8 240 240 54
    $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
        (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF 256, 256),
        [System.Drawing.Color]::FromArgb(255, 20, 184, 166), [System.Drawing.Color]::FromArgb(255, 15, 94, 89))
    $g.FillPath($gradient, $background)

    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    $g.FillPath($white, (New-RoundedPath 44 56 168 116 34))
    $tail = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF 78, 160), (New-Object System.Drawing.PointF 70, 208), (New-Object System.Drawing.PointF 122, 166))
    $g.FillPolygon($white, $tail)

    $bar = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 15, 94, 89))
    $heights = 28, 56, 76, 48, 30
    for ($i = 0; $i -lt $heights.Count; $i++) {
        $h = $heights[$i]
        $g.FillPath($bar, (New-RoundedPath (78 + $i * 22) (114 - $h / 2) 12 $h 6))
    }
    $g.Dispose()
    return $bitmap
}

function Get-PngBytes([System.Drawing.Bitmap]$bitmap) {
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return , $stream.ToArray()
}

$sizes = 256, 64, 48, 32, 16
$images = foreach ($size in $sizes) { , (Get-PngBytes (New-IconBitmap $size)) }
[System.IO.File]::WriteAllBytes((Join-Path $appDir 'icon.png'), $images[0])

# .ico med PNG-bilder i flera storlekar
$ico = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $ico
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dimension = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $writer.Write([byte]$dimension); $writer.Write([byte]$dimension); $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$images[$i].Length); $writer.Write([uint32]$offset)
    $offset += $images[$i].Length
}
foreach ($image in $images) { $writer.Write($image) }
$writer.Flush()
$iconPath = Join-Path $appDir 'icon.ico'
[System.IO.File]::WriteAllBytes($iconPath, $ico.ToArray())

# Genvägar
$shell = New-Object -ComObject WScript.Shell
$launcher = Join-Path $root 'scripts\app.ps1'
foreach ($folder in [Environment]::GetFolderPath('Desktop'), $root) {
    # Genvägen hette tidigare Röstbotar. Den nya ersätter den.
    $old = Join-Path $folder 'Röstbotar.lnk'
    if (Test-Path $old) { Remove-Item $old -Confirm:$false }
    $shortcut = $shell.CreateShortcut((Join-Path $folder 'ShatterBox.lnk'))
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
    $shortcut.WorkingDirectory = $root
    $shortcut.IconLocation = "$iconPath,0"
    $shortcut.WindowStyle = 7   # minimerat, så att inget konsolfönster blinkar till
    $shortcut.Description = 'Starta och hantera röstkaraktärerna'
    $shortcut.Save()
    Write-Host "Genväg skapad: $(Join-Path $folder 'ShatterBox.lnk')"
}
