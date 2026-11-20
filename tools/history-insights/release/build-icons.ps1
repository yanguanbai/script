# 从 release\assets 的 512 像素底图生成多尺寸 .ico（PNG 帧嵌入）。
# 只用 System.Drawing 缩图 + 手写 ICO 头，不依赖外部工具。
param(
  [string]$Assets = (Join-Path $PSScriptRoot 'assets'),
  [string]$Out = (Join-Path $PSScriptRoot 'payload')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sizes = @(16, 24, 32, 48, 64, 128, 256)

function New-Frame([System.Drawing.Image]$source, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($source, 0, 0, $size, $size)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return ,$ms.ToArray()
}

function Write-Ico([string]$pngPath, [string]$icoPath) {
  $source = [System.Drawing.Image]::FromFile($pngPath)
  $frames = @()
  foreach ($size in $sizes) { $frames += ,(New-Frame $source $size) }
  $source.Dispose()

  $count = $frames.Count
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$count)
  $offset = 6 + 16 * $count
  for ($i = 0; $i -lt $count; $i++) {
    $size = $sizes[$i]
    $dim = if ($size -ge 256) { 0 } else { $size }
    $bw.Write([Byte]$dim); $bw.Write([Byte]$dim)
    $bw.Write([Byte]0); $bw.Write([Byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$frames[$i].Length)
    $bw.Write([UInt32]$offset)
    $offset += $frames[$i].Length
  }
  foreach ($frame in $frames) { $bw.Write($frame) }
  $bw.Flush()
  [IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
  $bw.Dispose(); $ms.Dispose()
  Write-Host ('  ' + (Split-Path -Leaf $icoPath) + '  ' + [math]::Round((Get-Item $icoPath).Length / 1KB) + ' KB')
}

New-Item -ItemType Directory -Force $Out | Out-Null
foreach ($variant in @('dark', 'light')) {
  $src = Join-Path $Assets ('icon-' + $variant + '.png')
  if (-not (Test-Path $src)) { throw ('缺少底图：' + $src) }
  Write-Ico $src (Join-Path $Out ('history-insights-' + $variant + '.ico'))
}

# 读回来确认 Windows 能解析
foreach ($variant in @('dark', 'light')) {
  $ico = [System.Drawing.Icon]::new((Join-Path $Out ('history-insights-' + $variant + '.ico')))
  Write-Host ('  ' + $variant + ' 可解析，默认尺寸 ' + $ico.Width + 'x' + $ico.Height)
  $ico.Dispose()
}
