@echo off
setlocal
cd /d "%~dp0\..\.."
node --test
exit /b %errorlevel%
