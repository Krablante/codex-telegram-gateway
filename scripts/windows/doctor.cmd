@echo off
setlocal
cd /d "%~dp0\..\.."
node src\cli\doctor.js
exit /b %errorlevel%
