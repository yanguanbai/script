# 本地服务的一键启停：启动 = 起服务 + 打开报告；再执行一次 = 停止。
param(
  [ValidateSet('toggle', 'start', 'stop', 'status')]
  [string]$Action = 'toggle',
  [int]$Port = 4173,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-ServerProcess {
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $connection) { return $null }
  return Get-Process -Id ($connection | Select-Object -First 1).OwningProcess -ErrorAction SilentlyContinue
}

function Stop-Server {
  $process = Get-ServerProcess
  if (-not $process) { Write-Host "服务没在跑（端口 $Port 空闲）。"; return }
  Stop-Process -Id $process.Id -Force
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 200
    if (-not (Get-ServerProcess)) { Write-Host "已停止（PID $($process.Id)）。"; return }
  }
  Write-Host "停止超时，请手动结束进程 $($process.Id)。"
}

function Start-Server {
  $process = Get-ServerProcess
  if ($process) {
    Write-Host "服务已经在跑：http://127.0.0.1:$Port （PID $($process.Id)）"
    if (-not $NoOpen) { Start-Process "http://127.0.0.1:$Port/index.html?autoload=/local/latest.json" }
    return
  }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Write-Host '没找到 Node.js，请先安装：https://nodejs.org'; exit 1 }

  # 用环境变量传端口：PowerShell 5.1 的 Start-Process 不支持 -Environment
  $env:PORT = "$Port"
  Start-Process $node -ArgumentList 'server.mjs' -WorkingDirectory $root -WindowStyle Hidden
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (Get-ServerProcess) { break }
  }
  if (-not (Get-ServerProcess)) { Write-Host '启动失败：端口没起来。到本目录手动运行 node server.mjs 看看报错。'; exit 1 }

  Write-Host "已启动：http://127.0.0.1:$Port"
  if (-not $NoOpen) { Start-Process "http://127.0.0.1:$Port/index.html?autoload=/local/latest.json" }
}

switch ($Action) {
  'start' { Start-Server }
  'stop' { Stop-Server }
  'status' {
    $process = Get-ServerProcess
    if ($process) { Write-Host "运行中：http://127.0.0.1:$Port （PID $($process.Id)）" } else { Write-Host "未运行（端口 $Port 空闲）。" }
  }
  default {
    $process = Get-ServerProcess
    if ($process) { Stop-Server } else { Start-Server }
  }
}
