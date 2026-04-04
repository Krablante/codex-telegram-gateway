@echo off
setlocal
cd /d "%~dp0\..\.."
node src\cli\run.js
exit /b %errorlevel%
