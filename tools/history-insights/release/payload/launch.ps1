# 打开报告：先确保本地服务在跑，再用浏览器打开 http://127.0.0.1:4173/
# 用服务而不是直接双击 html，是因为「读最新备份 / 指定备份文件夹 / 导出长图 / 打印 PDF」都靠本地服务。
param([int]$Port = 4173, [switch]$NoOpen)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://127.0.0.1:$Port/"

function Test-Listening([int]$p) {
  return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

if (Test-Listening $Port) { if (-not $NoOpen) { Start-Process $url }; exit 0 }

$env:PORT = "$Port"
$node = Join-Path $here 'node\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show('没找到内置的 Node 运行时，安装包可能不完整，请重新安装。', 'History Insights') | Out-Null
  exit 1
}

Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory (Join-Path $here 'app\server') -WindowStyle Hidden

for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  if (Test-Listening $Port) { break }
}

if (-not $NoOpen) { Start-Process $url }
