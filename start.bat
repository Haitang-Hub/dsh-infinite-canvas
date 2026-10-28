@echo off
setlocal
chcp 65001 >nul

echo ============================================================
echo  Infinite Canvas - Startup
echo ============================================================
echo.

set "WEB_DIR=%~dp0web"

:: Install dependencies on first run
:: web needs --legacy-peer-deps: antd 6 conflicts with pro-components beta peer range
if not exist "%~dp0canvas-agent\node_modules" (
    echo [..] Installing canvas-agent dependencies, first run only
    pushd "%~dp0canvas-agent"
    call npm install
    if errorlevel 1 (
        popd
        echo [ERR] canvas-agent npm install failed
        exit /b 1
    )
    popd
)
if not exist "%WEB_DIR%\node_modules" (
    echo [..] Installing web dependencies, first run only
    pushd "%WEB_DIR%"
    call npm install --legacy-peer-deps
    if errorlevel 1 (
        popd
        echo [ERR] web npm install failed
        exit /b 1
    )
    popd
)

echo Starting services...
echo.

:: 1. Bridge (port 17371) - MCP 工具经此分发给浏览器执行器
start "Bridge 17371" cmd /k "pushd "%~dp0canvas-agent" && npm run dev"
echo [OK] Bridge started

:: 2. Web dev server (blocking, current window)
echo.
echo Web: http://localhost:5075
echo       (fixed port)
echo Press Ctrl+C to stop
echo.

pushd "%WEB_DIR%"
call npm run dev
popd

endlocal
