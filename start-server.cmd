@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=8787"
set "URL=http://localhost:%PORT%/"
title Nova - start server

echo.
echo  Nova chatbot - starting local server
echo  ------------------------------------
echo.

rem ---- Already serving? ------------------------------------------
rem Node is always here (the server itself runs on it), so use it to probe
rem instead of curl/PowerShell, which differ between Windows versions.
node scripts\wait-for-port.mjs %PORT% 2500
if not errorlevel 1 (
    echo  Nova is already running on %URL%
    echo.
    if /i not "%~1"=="/q" start "" "%URL%"
    goto :end
)

rem ---- Port already taken (an earlier copy may still be booting)? ---
netstat -ano | findstr /c:":%PORT%" | findstr /c:"LISTENING" >nul 2>&1
if not errorlevel 1 goto :wait

rem ---- Worker first (it holds the Gemini key) ----------------------
if not exist "node_modules\wrangler\bin\wrangler.js" goto :static

echo  Starting the Worker in its own window...
if not exist ".wrangler" mkdir ".wrangler"
start "Nova Server" /min cmd /c "node node_modules\wrangler\bin\wrangler.js dev --port %PORT% > .wrangler\server.log 2>&1"
goto :wait

:static
rem ---- Python available? -----------------------------------------
where python >nul 2>&1
if errorlevel 1 (
    echo  Python was not found on PATH.
    echo  Install Node and run "npm install", or run: npx serve public -l %PORT%
    echo.
    goto :end
)

rem ---- Start the static server in its own window ------------------
echo  Starting the static server in its own window...
echo  Note: a plain static server has no API proxy, so AI settings will ask for a key.
start "Nova Server" /min python -m http.server %PORT% --bind 127.0.0.1 --directory public

:wait
rem ---- Open the page as soon as the server answers -----------------
rem A cold Worker start (first run, antivirus, slow disk) can take a while,
rem so a detached helper watches the port and opens the browser itself. The
rem helper keeps running even if this window is closed.
if /i "%~1"=="/q" goto :wait_quiet

echo  Preparing %URL%
echo  The page opens in your browser as soon as the server is ready.
echo  The first start can take a minute - you can close this window.
echo.
start "Nova - open page" /min cmd /c "node scripts\wait-for-port.mjs %PORT% 300000 --open"
goto :end

:wait_quiet
node scripts\wait-for-port.mjs %PORT% 180000
if errorlevel 1 goto :timeout
goto :ready

:timeout
echo.
echo  The server did not answer in time.
echo  Recent output from the server window:
echo.
if exist ".wrangler\server.log" powershell -NoProfile -Command "Get-Content '.wrangler\server.log' -Tail 15"
echo.
echo  Try running this once in a terminal to see the full error:
echo      npm install
echo      npm run dev
echo.
goto :end

:ready
echo  Ready.
echo.
if /i not "%~1"=="/q" start "" "%URL%"
echo  Closing this window is fine - the server keeps running.
echo  Run stop-server.cmd when you are done.
echo.

:end
if /i not "%~1"=="/q" pause
endlocal
