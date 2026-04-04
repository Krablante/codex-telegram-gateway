@echo off
setlocal
cd /d "%~dp0\..\.."
node src\cli\run-omni.js
exit /b %errorlevel%
