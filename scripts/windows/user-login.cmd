@echo off
setlocal
cd /d "%~dp0\..\.."
node src\cli\user-login.js
exit /b %errorlevel%
