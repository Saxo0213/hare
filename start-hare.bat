@echo off
rem HARE launcher: double-click to run.
rem If port 5233 is already listening, reuse it; otherwise start the server first.
rem Server runs HIDDEN (2026-07-18 user request: no black console window) --
rem output goes to data\server.log; the in-app Dashboard (settings) shows status/log.
rem App-shell decision (2026-07-17, card W3): standalone --app window is the
rem standard form (no address bar / tabs, native-app feel).
rem Browser detection by file existence (msedge is NOT on PATH; where/start
rem resolution is unreliable). Fallback chain: Edge -> Chrome -> default browser.
rem NOTE: keep this file ASCII-only. CJK comments break under cp950 console
rem (UTF-8 bytes leak an '&' and the rest of the rem line gets executed).
cd /d "%~dp0"
netstat -ano | findstr /C:":5233 " | findstr "LISTENING" >nul
if errorlevel 1 (
  if not exist data mkdir data
  rem Absolute powershell path: THIS machine's PATH lacks powershell (2026-07-18
  rem incident: hidden start silently failed, server never came back after restart).
  rem Same lesson as ping/%SystemRoot% above -- never trust PATH in this bat.
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory '%~dp0.' -WindowStyle Hidden -RedirectStandardOutput '%~dp0data\server.log' -RedirectStandardError '%~dp0data\server-err.log'"
  rem ping-delay: immune to GNU-timeout PATH shadowing AND stdin redirection
  "%SystemRoot%\System32\ping.exe" -n 3 127.0.0.1 >nul
)
set "APPURL=http://localhost:5233"
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=%APPURL%
  goto :eof
)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app=%APPURL%
  goto :eof
)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=%APPURL%
  goto :eof
)
start "" %APPURL%
