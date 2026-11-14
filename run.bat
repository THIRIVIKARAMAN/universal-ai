@echo off
title Universal AI
cd /d "%~dp0"
start "" /min cmd /c "timeout /t 2 >nul & start chrome http://localhost:5173"
node serve.js
pause
