@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions EnableDelayedExpansion

title Azure OpenAI Proxy Setup
set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."
cd /d "%PROJECT_DIR%"

echo.
echo ========================================
echo   Azure OpenAI Proxy - Setup
echo ========================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [WARN] Node.js is not available in PATH.
    set /p "INSTALL_NODE=Install Node.js LTS automatically? (Y/N, default Y): "
    if /I "!INSTALL_NODE!"=="" set "INSTALL_NODE=Y"

    if /I "!INSTALL_NODE!"=="Y" (
        where winget >nul 2>nul
        if %ERRORLEVEL% equ 0 (
            echo [INFO] Installing Node.js LTS with winget...
            winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
            if %ERRORLEVEL% neq 0 (
                echo [ERROR] Automatic Node.js installation failed.
                echo [INFO] Manual install: https://nodejs.org/
                pause
                exit /b 1
            )
        ) else (
            echo [ERROR] winget is unavailable, so automatic installation cannot continue.
            echo [INFO] Manual install: https://nodejs.org/
            pause
            exit /b 1
        )

        where node >nul 2>nul
        if %ERRORLEVEL% neq 0 (
            echo [ERROR] Node.js is still not available in PATH after installation. Open a new terminal and run again.
            pause
            exit /b 1
        )
    ) else (
        echo [ERROR] Node.js is required to continue.
        pause
        exit /b 1
    )
)

echo [INFO] Node.js check complete.

echo [INFO] PowerShell will be used to validate your inputs.

if not exist ".env" (
    > .env echo AZURE_API_KEY=
    >> .env echo AZURE_BASE_URL=
    >> .env echo AZURE_OPENAI_BASE_URL=
    >> .env echo PORT=8081
    >> .env echo PROXY_MODEL_PROFILE=default
    >> .env echo PROXY_DEFAULT_PROFILE=default
)

set "EXISTING_API_KEY="
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$line = Get-Content '.env' | Where-Object { $_ -match '^AZURE_API_KEY=' } | Select-Object -Last 1; if ($line) { $line.Substring(14) }"`) do set "EXISTING_API_KEY=%%A"
set "EXISTING_AZURE_BASE_URL="
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$line = Get-Content '.env' | Where-Object { $_ -match '^AZURE_BASE_URL=' } | Select-Object -Last 1; if ($line) { $line.Substring(15) }"`) do set "EXISTING_AZURE_BASE_URL=%%A"
set "EXISTING_AZURE_OPENAI_BASE_URL="
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$line = Get-Content '.env' | Where-Object { $_ -match '^AZURE_OPENAI_BASE_URL=' } | Select-Object -Last 1; if ($line) { $line.Substring(22) }"`) do set "EXISTING_AZURE_OPENAI_BASE_URL=%%A"
set "EXISTING_PORT="
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$line = Get-Content '.env' | Where-Object { $_ -match '^PORT=' } | Select-Object -Last 1; if ($line) { $line.Substring(5) }"`) do set "EXISTING_PORT=%%A"
set "EXISTING_PROXY_MODEL_PROFILE="
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$line = Get-Content '.env' | Where-Object { $_ -match '^PROXY_MODEL_PROFILE=' } | Select-Object -Last 1; if ($line) { $line.Substring(20) }"`) do set "EXISTING_PROXY_MODEL_PROFILE=%%A"
set "CONFIG_AZURE_BASE_URL="
set "CONFIG_AZURE_OPENAI_BASE_URL="
set "CONFIG_PORT="
set "CONFIG_ACTIVE_MODEL_PROFILE="

if exist "config.yaml" for /f "tokens=1,* delims=:" %%A in ('findstr /b /c:"  baseUrl:" config.yaml') do set "CONFIG_AZURE_BASE_URL=%%B"
if exist "config.yaml" for /f "tokens=1,* delims=:" %%A in ('findstr /b /c:"  openAIBaseUrl:" config.yaml') do set "CONFIG_AZURE_OPENAI_BASE_URL=%%B"
if exist "config.yaml" for /f "tokens=1,* delims=:" %%A in ('findstr /b /c:"  port:" config.yaml') do set "CONFIG_PORT=%%B"
if exist "config.yaml" for /f "tokens=1,* delims=:" %%A in ('findstr /b /c:"activeModelProfile:" config.yaml') do set "CONFIG_ACTIVE_MODEL_PROFILE=%%B"
if defined CONFIG_AZURE_BASE_URL for /f "tokens=* delims= " %%A in ("!CONFIG_AZURE_BASE_URL!") do set "CONFIG_AZURE_BASE_URL=%%A"
if defined CONFIG_AZURE_OPENAI_BASE_URL for /f "tokens=* delims= " %%A in ("!CONFIG_AZURE_OPENAI_BASE_URL!") do set "CONFIG_AZURE_OPENAI_BASE_URL=%%A"
if defined CONFIG_PORT for /f "tokens=* delims= " %%A in ("!CONFIG_PORT!") do set "CONFIG_PORT=%%A"
if defined CONFIG_ACTIVE_MODEL_PROFILE for /f "tokens=* delims= " %%A in ("!CONFIG_ACTIVE_MODEL_PROFILE!") do set "CONFIG_ACTIVE_MODEL_PROFILE=%%A"
if defined CONFIG_AZURE_BASE_URL set "CONFIG_AZURE_BASE_URL=!CONFIG_AZURE_BASE_URL:"=!"
if defined CONFIG_AZURE_OPENAI_BASE_URL set "CONFIG_AZURE_OPENAI_BASE_URL=!CONFIG_AZURE_OPENAI_BASE_URL:"=!"
if defined CONFIG_PORT set "CONFIG_PORT=!CONFIG_PORT:"=!"
if defined CONFIG_ACTIVE_MODEL_PROFILE set "CONFIG_ACTIVE_MODEL_PROFILE=!CONFIG_ACTIVE_MODEL_PROFILE:"=!"

if "!EXISTING_AZURE_BASE_URL!"=="" set "EXISTING_AZURE_BASE_URL=!CONFIG_AZURE_BASE_URL!"
if "!EXISTING_AZURE_OPENAI_BASE_URL!"=="" set "EXISTING_AZURE_OPENAI_BASE_URL=!CONFIG_AZURE_OPENAI_BASE_URL!"
if "!EXISTING_PORT!"=="" set "EXISTING_PORT=!CONFIG_PORT!"
if "!EXISTING_PROXY_MODEL_PROFILE!"=="" set "EXISTING_PROXY_MODEL_PROFILE=!CONFIG_ACTIVE_MODEL_PROFILE!"

set "MASKED_API_KEY=(none)"
if not "!EXISTING_API_KEY!"=="" (
    for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$v=$env:EXISTING_API_KEY; if([string]::IsNullOrWhiteSpace($v)){ '(none)' } elseif($v.Length -le 8) { ('*' * $v.Length) } else { $v.Substring(0,4) + ('*' * ($v.Length-8)) + $v.Substring($v.Length-4) }"`) do set "MASKED_API_KEY=%%A"
)

if "!EXISTING_AZURE_BASE_URL!"=="" set "EXISTING_AZURE_BASE_URL=https://your-resource.services.ai.azure.com"
if "!EXISTING_AZURE_OPENAI_BASE_URL!"=="" set "EXISTING_AZURE_OPENAI_BASE_URL=https://your-resource.openai.azure.com"
if "!EXISTING_PORT!"=="" set "EXISTING_PORT=8081"
if "!EXISTING_PROXY_MODEL_PROFILE!"=="" set "EXISTING_PROXY_MODEL_PROFILE=default"

echo [INFO] Current AZURE_API_KEY: !MASKED_API_KEY!
set /p "INPUT_API_KEY=Enter new API key (Enter to keep existing): "
set "FINAL_API_KEY=!EXISTING_API_KEY!"
if not "!INPUT_API_KEY!"=="" set "FINAL_API_KEY=!INPUT_API_KEY!"
if "!FINAL_API_KEY!"=="" (
    echo [WARN] API key is empty. You can set it later in .env.
)

echo.
echo [INFO] Azure AI Foundry Base URL example: https://your-resource.services.ai.azure.com
echo [INFO] Current AZURE_BASE_URL: !EXISTING_AZURE_BASE_URL!
set /p "INPUT_AZURE_BASE_URL=Enter new Azure AI Foundry Base URL (Enter to keep existing): "
set "FINAL_AZURE_BASE_URL=!EXISTING_AZURE_BASE_URL!"
if not "!INPUT_AZURE_BASE_URL!"=="" set "FINAL_AZURE_BASE_URL=!INPUT_AZURE_BASE_URL!"

echo.
echo [INFO] Azure OpenAI Base URL example: https://your-resource.openai.azure.com
echo [INFO] Current AZURE_OPENAI_BASE_URL: !EXISTING_AZURE_OPENAI_BASE_URL!
set /p "INPUT_AZURE_OPENAI_BASE_URL=Enter new Azure OpenAI Base URL (Enter to keep existing): "
set "FINAL_AZURE_OPENAI_BASE_URL=!EXISTING_AZURE_OPENAI_BASE_URL!"
if not "!INPUT_AZURE_OPENAI_BASE_URL!"=="" set "FINAL_AZURE_OPENAI_BASE_URL=!INPUT_AZURE_OPENAI_BASE_URL!"

echo.
echo [INFO] Current PORT: !EXISTING_PORT!
set /p "INPUT_PORT=Enter proxy port (Enter to keep existing): "
set "FINAL_PORT=!EXISTING_PORT!"
if not "!INPUT_PORT!"=="" set "FINAL_PORT=!INPUT_PORT!"

echo.
echo Choose the active model profile:
echo   [1] default
echo   [2] claude-to-gpt
echo   [3] model-router
echo [INFO] Current PROXY_MODEL_PROFILE: !EXISTING_PROXY_MODEL_PROFILE!
set /p "MODE_CHOICE=Select (default 1): "
if "!MODE_CHOICE!"=="" set "MODE_CHOICE=1"

set "DEFAULT_PROFILE=default"
if "!MODE_CHOICE!"=="2" set "DEFAULT_PROFILE=claude-to-gpt"
if "!MODE_CHOICE!"=="3" set "DEFAULT_PROFILE=model-router"

set "NEW_AZURE_API_KEY=!FINAL_API_KEY!"
set "NEW_AZURE_BASE_URL=!FINAL_AZURE_BASE_URL!"
set "NEW_AZURE_OPENAI_BASE_URL=!FINAL_AZURE_OPENAI_BASE_URL!"
set "NEW_PORT=!FINAL_PORT!"
set "NEW_PROXY_MODEL_PROFILE=!DEFAULT_PROFILE!"
set "NEW_PROXY_DEFAULT_PROFILE=!DEFAULT_PROFILE!"

echo.
echo([INFO] Validating inputs...
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%setup-validate.ps1"
if %ERRORLEVEL% neq 0 (
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%setup-write-env.ps1"

if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to update .env
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
)

echo.
echo [SUCCESS] Setup complete
echo [INFO] Azure AI Foundry Base URL: !FINAL_AZURE_BASE_URL!
echo [INFO] Azure OpenAI Base URL: !FINAL_AZURE_OPENAI_BASE_URL!
echo [INFO] Port: !FINAL_PORT!
echo [INFO] Active profile: !DEFAULT_PROFILE!
echo [INFO] Run: scripts\start.bat
echo.
pause
