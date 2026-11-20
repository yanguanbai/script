# History Insights 安装脚本（由安装包自动调用，也可手动运行）
# 装到用户目录，不需要管理员权限；快捷方式、开始菜单、卸载项都在当前用户下。
# 覆盖安装即升级：先停掉正在跑的服务、清掉旧的程序文件，再装新的；用户配置（备份目录）不动。
param(
  [string]$Source = $PSScriptRoot,
  [string]$Dir = '',
  [string]$Version = '1.0.0',
  [switch]$NoShortcut,
  [switch]$NoLaunch,
  [switch]$NoAsk
)

$ErrorActionPreference = 'Stop'
if ($env:HISTORY_INSIGHTS_DIR) { $Dir = $env:HISTORY_INSIGHTS_DIR }
if ($env:HISTORY_INSIGHTS_NO_SHORTCUT -eq '1') { $NoShortcut = $true }
if ($env:HISTORY_INSIGHTS_NO_LAUNCH -eq '1') { $NoLaunch = $true }
if ($env:HISTORY_INSIGHTS_NO_ASK -eq '1') { $NoAsk = $true }
if ($env:HISTORY_INSIGHTS_VERSION) { $Version = $env:HISTORY_INSIGHTS_VERSION }
$Defaults = Join-Path $env:LOCALAPPDATA 'Programs\HistoryInsights'

if (-not $Dir) {
  # 已经在装过：沿用上次的位置直接升级，不再问（避免每次升级都弹框）
  $existing = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryInsights' -Name InstallLocation -ErrorAction SilentlyContinue).InstallLocation
  if (-not $existing -and (Test-Path (Join-Path $Defaults 'version.txt'))) { $existing = $Defaults }
  if ($existing -and (Test-Path $existing)) {
    $Dir = $existing
    Write-Host ('沿用上次的安装位置：' + $Dir)
  }
}

# 首次安装：让用户自己挑位置。选默认目录直接点「确定」即可；「取消」＝不装。
if (-not $Dir -and -not $NoAsk) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    New-Item -ItemType Directory -Force $Defaults | Out-Null
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = '选择 History Insights 的安装位置。直接用默认目录就点「确定」。'
    $dialog.SelectedPath = $Defaults
    $dialog.ShowNewFolderButton = $true
    $result = $dialog.ShowDialog()
    if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
      Write-Host '已取消安装，没有写入任何文件。'
      exit 1
    }
    $Dir = $dialog.SelectedPath
  } catch {
    Write-Host '无法弹出目录选择框，改用默认位置。'
  }
}

if (-not $Dir) { $Dir = $Defaults }
if ($Dir -eq $env:USERPROFILE -or $Dir -eq ($env:USERPROFILE + '\')) { throw '不能直接装到用户主目录，请换一个文件夹（例如「文档\HistoryInsights」）。' }

Write-Host '正在安装到' $Dir

# ---------- 升级：把旧版本收拾干净 ----------
$port = 4173
$oldVersion = ''
$versionFile = Join-Path $Dir 'version.txt'
if (Test-Path $versionFile) { $oldVersion = (Get-Content $versionFile -Raw).Trim() }

# 旧版可能正在后台跑，占着 server.mjs；先按端口找 PID 停掉，不然文件被锁、复制失败
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  foreach ($c in $conn) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 600
}

# 程序文件整个重建（旧版本的 app 里有 report.html / 观看报告.html 之类的历史残留，必须清掉）
$appDir = Join-Path $Dir 'app'
if (Test-Path $appDir) { Remove-Item $appDir -Recurse -Force }

New-Item -ItemType Directory -Force $Dir | Out-Null
Copy-Item (Join-Path $Source 'app') $Dir -Recurse -Force
if (Test-Path (Join-Path $Source 'node')) {
  New-Item -ItemType Directory -Force (Join-Path $Dir 'node') | Out-Null
  Copy-Item (Join-Path $Source 'node\*') (Join-Path $Dir 'node') -Force -Recurse
}
foreach ($name in @('uninstall.ps1', 'launch.ps1', '许可说明.txt')) {
  if (Test-Path (Join-Path $Source $name)) { Copy-Item (Join-Path $Source $name) $Dir -Force }
}
foreach ($ico in @('history-insights-dark.ico', 'history-insights-light.ico')) {
  if (Test-Path (Join-Path $Source $ico)) { Copy-Item (Join-Path $Source $ico) $Dir -Force }
}
[IO.File]::WriteAllText($versionFile, $Version, (New-Object System.Text.UTF8Encoding($false)))

# 图标跟着系统深浅色走（快捷方式的图标不会实时切换，所以装的时候就选好那一版）
$icoFile = Join-Path $Dir 'history-insights-dark.ico'
if (Test-Path (Join-Path $Dir 'history-insights-light.ico')) {
  $appsLight = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction SilentlyContinue).AppsUseLightTheme
  if ($appsLight -eq 1) { $icoFile = Join-Path $Dir 'history-insights-light.ico' }
}

# ---------- 入口 ----------
# 注意：.cmd 里绝对不能出现中文路径。cmd 默认按 GBK 读批处理，UTF-8 写的中文会被读成乱码，
# 路径找不到就直接退出，双击看着就像「点了没反应」。所以文件名和内容一律 ASCII。
# 网页在安装时改名 report.html（只有离线打开时才用它，正常入口一律走本地服务）。
$htmlSource = Join-Path $Dir 'app\观看报告.html'
$htmlPlain = Join-Path $Dir 'app\report.html'
if (Test-Path $htmlSource) { Move-Item $htmlSource $htmlPlain -Force }

$openCmd = @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch.ps1"
'@
$exportCmd = @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch.ps1"
'@
[IO.File]::WriteAllText((Join-Path $Dir '打开报告.cmd'), $openCmd, (New-Object System.Text.ASCIIEncoding))
[IO.File]::WriteAllText((Join-Path $Dir '导出长图与PDF.cmd'), $exportCmd, (New-Object System.Text.ASCIIEncoding))

if (-not $NoShortcut) {
  $shell = New-Object -ComObject WScript.Shell
  $desktop = [Environment]::GetFolderPath('Desktop')
  $menu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\History Insights'
  New-Item -ItemType Directory -Force $menu | Out-Null

  $link = $shell.CreateShortcut((Join-Path $desktop '观看报告.lnk'))
  $link.TargetPath = Join-Path $Dir '打开报告.cmd'
  $link.WorkingDirectory = $Dir
  $link.IconLocation = $icoFile
  $link.Description = 'History Insights：本地分析 B 站观看历史'
  $link.Save()

  $link2 = $shell.CreateShortcut((Join-Path $menu '观看报告.lnk'))
  $link2.TargetPath = Join-Path $Dir '打开报告.cmd'
  $link2.WorkingDirectory = $Dir
  $link2.IconLocation = $icoFile
  $link2.Save()

  $link3 = $shell.CreateShortcut((Join-Path $menu '导出长图与 PDF.lnk'))
  $link3.TargetPath = Join-Path $Dir '导出长图与PDF.cmd'
  $link3.WorkingDirectory = $Dir
  $link3.IconLocation = $icoFile
  $link3.Save()

  $link4 = $shell.CreateShortcut((Join-Path $menu '卸载 History Insights.lnk'))
  $link4.TargetPath = 'powershell.exe'
  $link4.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Dir 'uninstall.ps1') + '"'
  $link4.IconLocation = "$env:SystemRoot\System32\shell32.dll,31"
  $link4.Save()

  # 设置 - 应用 - 已安装应用 里出现条目，可正常卸载
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryInsights'
  New-Item -Path $key -Force | Out-Null
  $sizeKb = [int](((Get-ChildItem $Dir -Recurse -File | Measure-Object Length -Sum).Sum) / 1KB)
  Set-ItemProperty $key DisplayName 'History Insights 观看报告'
  Set-ItemProperty $key Publisher 'History Insights'
  Set-ItemProperty $key DisplayVersion $Version
  Set-ItemProperty $key InstallLocation $Dir
  Set-ItemProperty $key DisplayIcon $icoFile
  Set-ItemProperty $key EstimatedSize $sizeKb -Type DWord
  Set-ItemProperty $key NoModify 1 -Type DWord
  Set-ItemProperty $key NoRepair 1 -Type DWord
  Set-ItemProperty $key UninstallString ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Dir 'uninstall.ps1') + '"')
  Set-ItemProperty $key QuietUninstallString ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Dir 'uninstall.ps1') + '" -Quiet')
}

if ($oldVersion -and $oldVersion -ne $Version) { Write-Host ('已从 ' + $oldVersion + ' 升级到 ' + $Version) }
Write-Host ('安装完成。安装位置：' + $Dir)
if (-not $NoLaunch) { Start-Process (Join-Path $Dir '打开报告.cmd') }
