# 打发行包：一个双击就能装的 Setup.exe + 一个解压即用的便携 zip。
# 用法（在仓库根目录）：powershell -ExecutionPolicy Bypass -File tools\history-insights\release\build.ps1
param(
  [switch]$SkipNode,
  [string]$Version = '1.0.0'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$stage = Join-Path $here '.stage'
$dist = Join-Path $here 'dist'
$payloadZip = Join-Path $stage 'payload.zip'

Write-Host '1/5 生成单文件网页'
Push-Location $root
node build-standalone.mjs | Out-Null
Pop-Location

Write-Host '2/5 收集程序文件'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $stage 'app') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $stage 'app\server') | Out-Null
New-Item -ItemType Directory -Force $dist | Out-Null

Copy-Item (Join-Path $root '观看报告.html') (Join-Path $stage 'app\观看报告.html')
$serverFiles = @('index.html', 'observatory.css', 'app.js', 'worker.js', 'analytics.mjs', 'content-domains.mjs', 'server.mjs', 'exporter.mjs', 'README.md')
foreach ($name in $serverFiles) {
  if (Test-Path (Join-Path $root $name)) { Copy-Item (Join-Path $root $name) (Join-Path $stage 'app\server') }
}
Copy-Item (Join-Path $root 'vendor') (Join-Path $stage 'app\server') -Recurse
Copy-Item (Join-Path $here 'payload\install.ps1') $stage
Copy-Item (Join-Path $here 'payload\launch.ps1') $stage
Copy-Item (Join-Path $here 'payload\uninstall.ps1') $stage
Copy-Item (Join-Path $here 'payload\许可说明.txt') $stage
# 快捷方式图标：从 assets 里的 512 底图现场生成多尺寸 ico，避免仓库里存二进制大文件
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'build-icons.ps1') | Out-Null
Copy-Item (Join-Path $here 'payload\history-insights-dark.ico') $stage
Copy-Item (Join-Path $here 'payload\history-insights-light.ico') $stage

if (-not $SkipNode) {
  $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($nodeExe) {
    New-Item -ItemType Directory -Force (Join-Path $stage 'node') | Out-Null
    Copy-Item $nodeExe (Join-Path $stage 'node\node.exe')
    Write-Host ('   内置 Node.js：' + [Math]::Round((Get-Item $nodeExe).Length / 1MB, 1) + ' MB')
  } else {
    Write-Host '   没找到 node.exe，导出功能将依赖用户自己安装 Node.js'
  }
}

Write-Host '3/5 打包 payload.zip'
# 便携包也要能一键用：根上放一个 ASCII 的启动脚本，网页顺带改名成 report.html
$bundleHtml = Join-Path $stage 'app\观看报告.html'
if (Test-Path $bundleHtml) { Copy-Item $bundleHtml (Join-Path $stage 'app\report.html') -Force }
$launchCmd = @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch.ps1"
'@
[IO.File]::WriteAllText((Join-Path $stage '打开报告.cmd'), $launchCmd, (New-Object System.Text.ASCIIEncoding))

Remove-Item $payloadZip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $payloadZip -CompressionLevel Optimal

Write-Host '4/5 生成安装入口'
$installCmd = @"
@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "`$z = Join-Path `$env:TEMP ('HistoryInsights-Setup-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Force -Path `$z | Out-Null; Expand-Archive -Path 'payload.zip' -DestinationPath `$z -Force; try { & (Join-Path `$z 'install.ps1') -Source `$z -Version '$Version' } finally { Remove-Item -Recurse -Force `$z -ErrorAction SilentlyContinue }"
"@
[IO.File]::WriteAllText((Join-Path $stage 'install.cmd'), $installCmd, (New-Object System.Text.ASCIIEncoding))

$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$dist\HistoryInsights-Setup.exe
FriendlyName=History Insights $Version
AppLaunched=install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles

[Strings]
FILE0="payload.zip"
FILE1="install.cmd"

[SourceFiles]
SourceFiles0=$stage\

[SourceFiles0]
%FILE0%=
%FILE1%=
"@
[IO.File]::WriteAllText((Join-Path $stage 'setup.sed'), $sed, (New-Object System.Text.ASCIIEncoding))

Write-Host '5/5 生成 Setup.exe'
Remove-Item (Join-Path $dist 'HistoryInsights-Setup.exe') -Force -ErrorAction SilentlyContinue
Start-Process 'C:\Windows\System32\iexpress.exe' -ArgumentList "/N /Q $(Join-Path $stage 'setup.sed')" -Wait -WindowStyle Hidden
Copy-Item $payloadZip (Join-Path $dist "HistoryInsights-$Version-portable.zip") -Force

$exe = Get-Item (Join-Path $dist 'HistoryInsights-Setup.exe') -ErrorAction SilentlyContinue
if (-not $exe) { throw '安装包生成失败' }
Write-Host ('完成：' + $exe.FullName + '（' + [Math]::Round($exe.Length / 1MB, 1) + ' MB）')
Write-Host ('便携包：' + (Join-Path $dist "HistoryInsights-$Version-portable.zip"))
