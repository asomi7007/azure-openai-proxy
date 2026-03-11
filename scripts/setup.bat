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
    echo [WARN] Node.js가 PATH에 없습니다.
    set /p "INSTALL_NODE=Node.js LTS를 자동 설치할까요? (Y/N, 기본 Y): "
    if /I "!INSTALL_NODE!"=="" set "INSTALL_NODE=Y"

    if /I "!INSTALL_NODE!"=="Y" (
        where winget >nul 2>nul
        if %ERRORLEVEL% equ 0 (
            echo [INFO] winget으로 Node.js LTS 설치 시도...
            winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
            if %ERRORLEVEL% neq 0 (
                echo [ERROR] Node.js 자동 설치에 실패했습니다.
                echo [INFO] 수동 설치: https://nodejs.org/
                pause
                exit /b 1
            )
        ) else (
            echo [ERROR] winget이 없어 자동 설치를 진행할 수 없습니다.
            echo [INFO] 수동 설치: https://nodejs.org/
            pause
            exit /b 1
        )

        where node >nul 2>nul
        if %ERRORLEVEL% neq 0 (
            echo [ERROR] Node.js 설치 후에도 PATH에서 찾지 못했습니다. 새 터미널에서 다시 실행하세요.
            pause
            exit /b 1
        )
    ) else (
        echo [ERROR] Node.js가 없으면 실행할 수 없습니다.
        pause
        exit /b 1
    )
)

echo [INFO] Node.js 확인 완료.

if not exist ".env" (
    > .env echo AZURE_API_KEY=
    >> .env echo PROXY_DEFAULT_PROFILE=default
)

set "EXISTING_API_KEY="
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$line = Get-Content '.env' | Where-Object { $_ -match '^AZURE_API_KEY=' } | Select-Object -Last 1; if ($line) { $line.Substring(14) }"`) do set "EXISTING_API_KEY=%%A"

set "MASKED_API_KEY=(none)"
if not "!EXISTING_API_KEY!"=="" (
    for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$v=$env:EXISTING_API_KEY; if([string]::IsNullOrWhiteSpace($v)){ '(none)' } elseif($v.Length -le 8) { ('*' * $v.Length) } else { $v.Substring(0,4) + ('*' * ($v.Length-8)) + $v.Substring($v.Length-4) }"`) do set "MASKED_API_KEY=%%A"
)

echo [INFO] 현재 AZURE_API_KEY: !MASKED_API_KEY!
set /p "INPUT_API_KEY=새 API 키 입력 (Enter=기존값 유지): "
set "FINAL_API_KEY=!EXISTING_API_KEY!"
if not "!INPUT_API_KEY!"=="" set "FINAL_API_KEY=!INPUT_API_KEY!"

if "!FINAL_API_KEY!"=="" (
    echo [WARN] API 키가 비어 있습니다. 나중에 .env에서 설정하세요.
)

echo.
echo 기본 시작 모드를 선택하세요:
echo   [1] default
echo   [2] claude-to-gpt
echo   [3] model-router
set /p "MODE_CHOICE=선택 (기본 1): "
if "!MODE_CHOICE!"=="" set "MODE_CHOICE=1"

set "DEFAULT_PROFILE=default"
if "!MODE_CHOICE!"=="2" set "DEFAULT_PROFILE=claude-to-gpt"
if "!MODE_CHOICE!"=="3" set "DEFAULT_PROFILE=model-router"

set "NEW_AZURE_API_KEY=!FINAL_API_KEY!"
set "NEW_PROXY_DEFAULT_PROFILE=!DEFAULT_PROFILE!"

powershell -NoProfile -Command ^
"$p='.env'; if (!(Test-Path $p)) { New-Item -ItemType File -Path $p | Out-Null }; $lines=Get-Content $p -ErrorAction SilentlyContinue; if(-not $lines){$lines=@()};" ^
"function Set-Key([string]$key,[string]$value){" ^
"  $prefix = $key + '=';" ^
"  $script:lines = @($script:lines | Where-Object { $_ -notmatch ('^' + [regex]::Escape($prefix)) });" ^
"  $script:lines += ($prefix + $value);" ^
"};" ^
"Set-Key 'AZURE_API_KEY' $env:NEW_AZURE_API_KEY;" ^
"Set-Key 'PROXY_DEFAULT_PROFILE' $env:NEW_PROXY_DEFAULT_PROFILE;" ^
"Set-Content -Path $p -Value $lines -Encoding UTF8"

if %ERRORLEVEL% neq 0 (
    echo [ERROR] .env 업데이트 실패
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [INFO] 의존성 설치 중...
    npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] npm install 실패
        pause
        exit /b 1
    )
)

echo.
echo [SUCCESS] Setup 완료
echo [INFO] 기본 프로필: !DEFAULT_PROFILE!
echo [INFO] 실행: scripts\start.bat
echo.
pause
