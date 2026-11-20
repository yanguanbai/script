# 打开报告：先确保本地服务在跑，再用浏览器打开 http://127.0.0.1:<Port>/
# 用服务而不是直接双击 html，是因为「读最新备份 / 指定备份文件夹 / 导出长图 / 打印 PDF」都靠本地服务。
#
# Node 运行时来源，按顺序尝试：
#   1. 安装包自带的 node\node.exe（发行版一定有，别人电脑不用装 Node）
#   2. 环境变量 HISTORY_INSIGHTS_NODE 指定的路径（自动化测试用）
#   3. PATH 里的 node（用仓库源码跑的、或者自己装过 Node 的电脑）
#   4. 几个常见的 Node 安装目录
# 全都找不到才提示用户：一句话说清发生了什么 + 给下载入口，不会静默退出。
param([int]$Port = 4173, [switch]$NoOpen)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://127.0.0.1:$Port/"
$downloadUrl = 'https://nodejs.org/zh-cn/download'

function Test-Listening([int]$p) {
  return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

function Find-Node {
  $bundled = Join-Path $here 'node\node.exe'
  if (Test-Path $bundled) { return @{ Path = $bundled; Source = '内置运行时' } }

  if ($env:HISTORY_INSIGHTS_NODE -and (Test-Path $env:HISTORY_INSIGHTS_NODE)) {
    return @{ Path = $env:HISTORY_INSIGHTS_NODE; Source = 'HISTORY_INSIGHTS_NODE 指定' }
  }

  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and (Test-Path $cmd.Source)) { return @{ Path = $cmd.Source; Source = 'PATH 里的 Node' } }

  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return @{ Path = $c; Source = '常见安装目录' } } }

  return $null
}

if (Test-Listening $Port) { if (-not $NoOpen) { Start-Process $url }; exit 0 }

$nodeInfo = Find-Node
if (-not $nodeInfo) {
  $msg = @(
    '没有找到可用的 Node.js 运行时，报告页面起不来。',
    '',
    '装的发行版：说明安装包里的 node\node.exe 不见了，多半是解压不完整或被安全软件删掉了——重新运行一次 Setup 最省事。',
    '用仓库源码跑的：装一个 Node.js（LTS 版即可）后再双击本文件。',
    '',
    '点「是」打开 Node.js 下载页，点「否」退出。'
  ) -join "`r`n"

  if ($env:HISTORY_INSIGHTS_NO_NODE_DIALOG -eq '1') {
    Write-Host $msg
    exit 1
  }

  Add-Type -AssemblyName System.Windows.Forms
  $answer = [System.Windows.Forms.MessageBox]::Show($msg, 'History Insights 需要 Node.js',
    [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning)
  if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { Start-Process $downloadUrl }
  exit 1
}

Write-Host ('使用 Node 运行时：' + $nodeInfo.Path + '（' + $nodeInfo.Source + '）')
$env:PORT = "$Port"
Start-Process -FilePath $nodeInfo.Path -ArgumentList 'server.mjs' -WorkingDirectory (Join-Path $here 'app\server') -WindowStyle Hidden

for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  if (Test-Listening $Port) { break }
}

if (-not $NoOpen) { Start-Process $url }
