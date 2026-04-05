@echo off
setlocal
cd /d "%~dp0\..\.."
node src\cli\admin.js %*
exit /b %errorlevel%
