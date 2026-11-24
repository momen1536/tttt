@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=8787"
set "PIDFILE=%~dp0server.pid"
title Nova - stop server

echo.
echo  Nova chatbot - stopping local server
echo  ------------------------------------
echo.

powershell -NoProfile -Command "$ids = @(); if (Test-Path '%PIDFILE%') { $saved = Get-Content '%PIDFILE%' | Select-Object -First 1; if ($saved -match '^\d+$') { $ids += [int]$saved } }; $ids += @(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); $ids = @($ids | Where-Object { $_ -gt 0 } | Select-Object -Unique); if (Test-Path '%PIDFILE%') { Remove-Item '%PIDFILE%' -Force -ErrorAction SilentlyContinue }; if ($ids.Count -eq 0) { Write-Host '  Nothing was running on port %PORT%.' } else { foreach ($procId in $ids) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue; Write-Host ('  Stopped process ' + $procId + ' on port %PORT%.') } }"

echo.
if /i not "%~1"=="/q" pause
endlocal
