# Infinite Canvas - Local Startup
$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
$webDir = Join-Path $root "web"
$agentDir = Join-Path $root "canvas-agent"

function Test-PortListening([int]$Port) {
    try {
        $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
        return [bool]($listeners | Where-Object { $_.Port -eq $Port } | Select-Object -First 1)
    } catch { return $false }
}

# 端口在听不代表是我们家的桥——再 curl /health 核对 plugin 身份字段，
# 防止其它进程（如别的项目的 agent）占着端口被误当桥复用。
function Test-BridgeHealth([int]$Port, [string]$Plugin) {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
        return [bool]($health.plugin -eq $Plugin)
    } catch { return $false }
}

Write-Host "============ Infinite Canvas - Startup ============" -ForegroundColor Cyan

# --- node check ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERR] node not found in PATH, install Node.js >=18 first" -ForegroundColor Red
    exit 1
}

# --- install dependencies on first run ---
# web needs --legacy-peer-deps: antd 6 conflicts with pro-components beta peer range
if (-not (Test-Path "$agentDir/node_modules")) {
    Write-Host "[..] Installing canvas-agent dependencies, first run only..." -ForegroundColor Cyan
    Push-Location $agentDir
    npm install
    $failed = ($LASTEXITCODE -ne 0)
    Pop-Location
    if ($failed) { Write-Host "[ERR] canvas-agent npm install failed" -ForegroundColor Red; exit 1 }
}
if (-not (Test-Path "$webDir/node_modules")) {
    Write-Host "[..] Installing web dependencies, first run only..." -ForegroundColor Cyan
    Push-Location $webDir
    npm install --legacy-peer-deps
    $failed = ($LASTEXITCODE -ne 0)
    Pop-Location
    if ($failed) { Write-Host "[ERR] web npm install failed" -ForegroundColor Red; exit 1 }
}

Write-Host "Starting services..." -ForegroundColor Cyan

# --- 1. Dev bridge (port 17381; Desktop plugin bridge keeps 17371) ---
# Dev and plugin bridges use separate ports since 2026-10-31, so they never clash.
if (Test-PortListening 17381) {
    if (Test-BridgeHealth 17381 "infinite-canvas") {
        Write-Host "  dev bridge 17381 already listening - reusing it" -ForegroundColor Green
    } else {
        Write-Host "[WARN] port 17381 is occupied by another service (not the infinite-canvas dev bridge) - skipping dev bridge" -ForegroundColor Yellow
    }
} elseif (-not (Test-Path "$agentDir/agent-instructions.md")) {
    Write-Host "[WARN] canvas-agent/agent-instructions.md missing - skipping dev bridge" -ForegroundColor Yellow
} else {
    Start-Process cmd -ArgumentList '/k', 'title Bridge 17381 && set PORT=17381&& npm run dev' -WorkingDirectory $agentDir
    Write-Host "  dev bridge started on 17381" -ForegroundColor Green
}

# --- 2. Web dev server (fixed port 5075) ---
if (Test-PortListening 5075) {
    Write-Host "  Web 5075 already listening - opening browser only" -ForegroundColor Green
    Start-Process "http://localhost:5075"
    exit 0
}

# open browser once the dev server is up (delayed, non-blocking)
Start-Process cmd -ArgumentList '/c', 'timeout /t 4 >nul && start http://localhost:5075' -WindowStyle Hidden

Write-Host ""
Write-Host "Web: http://localhost:5075 (fixed port)" -ForegroundColor Yellow
Write-Host "Bridge: http://localhost:17381 (dev; Desktop plugin bridge uses 17371, auto-discovered)" -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop the web server; close other service windows manually" -ForegroundColor Gray
Write-Host ""

Set-Location $webDir
npm run dev
