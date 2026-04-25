@echo off
setlocal
cd /d "%~dp0\..\.."
node scripts\run-node-tests.mjs %*
exit /b %errorlevel%
