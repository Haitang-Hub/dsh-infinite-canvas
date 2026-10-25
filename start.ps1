# Infinite Canvas - Local Startup
$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
$webDir = Join-Path $root "web"
$agentDir = Join-Path $root "canvas-agent"
$proxyDir = Join-Path $root "canvas-proxy"

# Write proxy config for web
New-Item "$webDir/public" -ItemType Directory -Force | Out-Null
$config = @'
// Auto-injected by start script
window.__INFINITE_CANVAS_CONFIG__ = window.__INFINITE_CANVAS_CONFIG__ || {};
window.__INFINITE_CANVAS_CONFIG__.autoProxyEnabled = true;
window.__INFINITE_CANVAS_CONFIG__.autoProxyUrl = "http://127.0.0.1:23210";
'@
[System.IO.File]::WriteAllText("$webDir/public/config.js", $config, [System.Text.UTF8Encoding]::new($false))

# Install dependencies on first run (canvas-proxy has no dependencies)
# web needs --legacy-peer-deps: antd 6 conflicts with pro-components beta peer range
if (-not (Test-Path "$agentDir/node_modules")) {
    Write-Host "Installing canvas-agent dependencies, first run only..." -ForegroundColor Cyan
    Push-Location $agentDir
    npm install
    $failed = ($LASTEXITCODE -ne 0)
    Pop-Location
    if ($failed) { Write-Host "canvas-agent npm install failed" -ForegroundColor Red; exit 1 }
}
if (-not (Test-Path "$webDir/node_modules")) {
    Write-Host "Installing web dependencies, first run only..." -ForegroundColor Cyan
    Push-Location $webDir
    npm install --legacy-peer-deps
    $failed = ($LASTEXITCODE -ne 0)
    Pop-Location
    if ($failed) { Write-Host "web npm install failed" -ForegroundColor Red; exit 1 }
}

Write-Host "Starting services..." -ForegroundColor Cyan

# 1. Bridge (port 17371) - MCP 工具经此分发给浏览器执行器
Start-Process cmd -ArgumentList '/k', 'title Bridge 17371 && npm run dev' -WorkingDirectory $agentDir
Write-Host "  Bridge started" -ForegroundColor Green

# 2. Proxy (port 23210) - local source, output shown directly in window
Start-Process cmd -ArgumentList '/k', 'title Proxy 23210 && node index.js' -WorkingDirectory $proxyDir
Write-Host "  Proxy started" -ForegroundColor Green

# 3. Web dev server (port 5070, falls back to 5075 if busy) - runs in current window
Write-Host ""
Write-Host "Web: http://localhost:5070 (falls back to 5075 if port 5070 is busy)" -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop all" -ForegroundColor Gray
Write-Host ""

Set-Location $webDir
npm run dev
