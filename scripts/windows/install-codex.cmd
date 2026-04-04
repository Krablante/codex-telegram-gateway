@echo off
setlocal
call npm.cmd install -g @openai/codex --ignore-scripts --no-audit --no-fund
exit /b %errorlevel%
