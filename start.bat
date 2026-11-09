@echo off
rem Thin launcher for start.ps1 - all logic lives there
rem Usage: start.bat
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
