@echo off
setlocal
cd /d "%~dp0\..\.."
node src\cli\user-status.js
exit /b %errorlevel%
