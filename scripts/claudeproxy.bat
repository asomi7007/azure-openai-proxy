@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."
set "HELPER_PS1=%SCRIPT_DIR%claudeproxy.ps1"

if "%~1"=="" (
    set "MODE=toggle"
) else (
    set "MODE=%~1"
)

if defined CLAUDEPROXY_SETTINGS_PATH (
    set "SETTINGS_PATH=%CLAUDEPROXY_SETTINGS_PATH%"
) else (
    set "SETTINGS_PATH=%USERPROFILE%\.claude\settings.json"
)

if defined CLAUDEPROXY_STATE_PATH (
    set "STATE_PATH=%CLAUDEPROXY_STATE_PATH%"
) else (
    set "STATE_PATH=%USERPROFILE%\.claude\claudeproxy-state.json"
)

if defined CLAUDEPROXY_LOCAL_URL (
    set "LOCAL_PROXY_URL=%CLAUDEPROXY_LOCAL_URL%"
) else (
    set "LOCAL_PROXY_URL=http://localhost:8081"
)

if not exist "%HELPER_PS1%" (
    echo [ERROR] Missing helper: %HELPER_PS1%
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPER_PS1%" -Mode "%MODE%" -SettingsPath "%SETTINGS_PATH%" -StatePath "%STATE_PATH%" -LocalProxyUrl "%LOCAL_PROXY_URL%"
exit /b %ERRORLEVEL%
