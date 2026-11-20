# History Insights 卸载脚本
param([string]$Dir = '', [switch]$Quiet)
$ErrorActionPreference = 'SilentlyContinue'
if (-not $Dir) { $Dir = Join-Path $env:LOCALAPPDATA 'Programs\HistoryInsights' }

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\History Insights'
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) '观看报告.lnk'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryInsights'

Remove-Item $desktopLink -Force
Remove-Item $startMenu -Recurse -Force
Remove-Item $uninstallKey -Recurse -Force

# 脚本自己可能就在安装目录里跑，交给新进程等两秒再删目录
# 用 ping 当延时：timeout 在非交互窗口里会因为输入重定向直接报错，删不掉目录
$cmdLine = '/c ping -n 3 127.0.0.1 >nul & rmdir /s /q "' + $Dir + '"'
Start-Process cmd.exe -ArgumentList $cmdLine -WindowStyle Hidden
if (-not $Quiet) { Write-Host '已卸载 History Insights。' }
