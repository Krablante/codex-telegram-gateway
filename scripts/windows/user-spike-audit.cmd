@echo off
setlocal
cd /d "%~dp0\..\.."
node src\cli\user-live-spike-audit.js
exit /b %errorlevel%
