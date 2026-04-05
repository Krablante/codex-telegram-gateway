@echo off
setlocal
cd /d "%~dp0\..\.."
node src\cli\user-live-e2e.js
exit /b %errorlevel%
