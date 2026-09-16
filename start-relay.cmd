@echo off
rem ChatGPT Bridge relay - WebSocket + HTTP on 127.0.0.1:8742
cd /d "%~dp0"
node relay\server.js
pause
