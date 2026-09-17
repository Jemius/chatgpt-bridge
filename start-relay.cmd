@echo off
rem ChatGPT Bridge relay - WebSocket + HTTP on 127.0.0.1:8742
cd /d "%~dp0"
rem Audit F2 (2026-09-18): the relay loads its version once at startup, so an
rem old process left running silently masks every code change behind it (that
rem is exactly how a v1.2.11 relay survived a v1.2.12 fix). Kill any stale
rem LISTENER on the port before starting; :8742 belongs to this bridge.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":8742[^0-9]" ^| findstr LISTENING') do (
  echo [start-relay] killing stale relay process PID %%a
  taskkill /PID %%a /F >nul 2>&1
)
node relay\server.js
pause
