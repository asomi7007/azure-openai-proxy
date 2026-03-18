@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions EnableDelayedExpansion
:: Azure OpenAI Proxy start script
:: Can be run from anywhere (double-click or command line)

title Azure OpenAI Proxy
set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."
set "PROFILE=%~1"
set "PROFILE_SOURCE=command-line argument"
set "ENV_DEFAULT_PROFILE="
set "CLAUDE_PROXY_HELPER=%PROJECT_DIR%\scripts\claudeproxy.bat"

cd /d "%PROJECT_DIR%"

if exist ".env" (
    for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$line = Get-Content '.env' | Where-Object { $_ -match '^PROXY_DEFAULT_PROFILE=' } | Select-Object -Last 1; if ($line) { $line.Substring(22) }"`) do set "ENV_DEFAULT_PROFILE=%%A"
)

if "!PROFILE!"=="" (
    set "PROFILE=default"
    set "PROFILE_SOURCE=built-in default"
    if not "!ENV_DEFAULT_PROFILE!"=="" (
        set "PROFILE=!ENV_DEFAULT_PROFILE!"
        set "PROFILE_SOURCE=.env PROXY_DEFAULT_PROFILE"
    )
)
set "PROXY_MODEL_PROFILE=!PROFILE!"

echo.
echo ========================================
echo   Azure OpenAI Proxy - Starting...
echo ========================================
echo   Active Profile: !PROXY_MODEL_PROFILE!
if exist ".env" (
    if not "!ENV_DEFAULT_PROFILE!"=="" (
        echo   Saved Default Profile from .env: !ENV_DEFAULT_PROFILE!
    ) else (
        echo   Saved Default Profile from .env: not set
    )
) else (
    echo   Saved Default Profile from .env: .env not found
)
echo   Profile Source: !PROFILE_SOURCE!
echo.

if exist "!CLAUDE_PROXY_HELPER!" (
    set "CLAUDE_PROXY_STATUS="
    for /f "usebackq delims=" %%A in (`call "!CLAUDE_PROXY_HELPER!" status 2^>nul`) do set "CLAUDE_PROXY_STATUS=%%A"

    if /I "!CLAUDE_PROXY_STATUS!"=="LOCAL_PROXY" (
        echo [INFO] Claude Code setting already points to the local proxy.
        echo.
    ) else (
        echo [INFO] Claude Code setting is not using the local proxy.
        choice /C YN /M "Switch Claude Code to http://localhost:8081 before starting?"
        if errorlevel 2 (
            echo [INFO] Keeping the current Claude Code setting.
            echo.
        ) else (
            call "!CLAUDE_PROXY_HELPER!" ensure-local
            if !ERRORLEVEL! neq 0 (
                echo [WARN] Failed to update Claude Code setting automatically.
            )
            echo.
        )
    )
)

:: Check if node is available
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not available in PATH.
    echo Install it from https://nodejs.org/
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo.
)

:: Check if config.yaml exists
if not exist "config.yaml" (
    echo [ERROR] config.yaml is missing.
    echo Create config.yaml in the project root.
    pause
    exit /b 1
)

:: Check if .env exists
if not exist ".env" (
    echo [WARN] .env is missing. The AZURE_API_KEY environment variable is required.
    echo.
)

echo [INFO] Starting proxy server...
echo [INFO] Stop with Ctrl+C or scripts\stop.bat
echo.

node src/index.mjs

:: If node exits, pause so user can see the error
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Proxy exited with error code %ERRORLEVEL%.
    pause
)
