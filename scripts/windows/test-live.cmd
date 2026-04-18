@echo off
setlocal
pushd "%~dp0\..\.."
node src\cli\run-live-tests.js %*
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
