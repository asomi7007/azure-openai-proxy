@echo off
chcp 65001 >nul 2>&1
setlocal
set "SCRIPT_DIR=%~dp0"
call "%SCRIPT_DIR%scripts\claudeproxy.bat" %*
exit /b %ERRORLEVEL%
