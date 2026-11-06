@echo off
setlocal
title Intrinsic
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 pause
endlocal
