@echo off
chcp 65001 >nul 2>&1
:: Azure OpenAI Proxy start script
:: Can be run from anywhere (double-click or command line)

title Azure OpenAI Proxy
set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."
set "PROFILE=%~1"

cd /d "%PROJECT_DIR%"

if "%PROFILE%"=="" (
    set "PROFILE=default"
    if exist ".env" (
        for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$line = Get-Content '.env' | Where-Object { $_ -match '^PROXY_DEFAULT_PROFILE=' } | Select-Object -Last 1; if ($line) { $line.Substring(22) }"`) do set "PROFILE=%%A"
    )
)
set "PROXY_MODEL_PROFILE=%PROFILE%"

echo.
echo ========================================
echo   Azure OpenAI Proxy - Starting...
echo ========================================
echo   Active Profile: %PROXY_MODEL_PROFILE%
echo.

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
