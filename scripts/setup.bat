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

echo [INFO] 입력값 검증을 위해 PowerShell을 사용합니다.

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

set "MASKED_API_KEY=(none)"
if not "!EXISTING_API_KEY!"=="" (
    for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$v=$env:EXISTING_API_KEY; if([string]::IsNullOrWhiteSpace($v)){ '(none)' } elseif($v.Length -le 8) { ('*' * $v.Length) } else { $v.Substring(0,4) + ('*' * ($v.Length-8)) + $v.Substring($v.Length-4) }"`) do set "MASKED_API_KEY=%%A"
)

if "!EXISTING_AZURE_BASE_URL!"=="" set "EXISTING_AZURE_BASE_URL=https://your-resource.services.ai.azure.com"
if "!EXISTING_AZURE_OPENAI_BASE_URL!"=="" set "EXISTING_AZURE_OPENAI_BASE_URL=https://your-resource.openai.azure.com"
if "!EXISTING_PORT!"=="" set "EXISTING_PORT=8081"
if "!EXISTING_PROXY_MODEL_PROFILE!"=="" set "EXISTING_PROXY_MODEL_PROFILE=default"

echo [INFO] 현재 AZURE_API_KEY: !MASKED_API_KEY!
set /p "INPUT_API_KEY=새 API 키 입력 (Enter=기존값 유지): "
set "FINAL_API_KEY=!EXISTING_API_KEY!"
if not "!INPUT_API_KEY!"=="" set "FINAL_API_KEY=!INPUT_API_KEY!"
if "!FINAL_API_KEY!"=="" (
    echo [WARN] API 키가 비어 있습니다. 나중에 .env에서 설정하세요.
)

echo.
echo [INFO] Azure AI Foundry Base URL 예시: https://your-resource.services.ai.azure.com
echo [INFO] 현재 AZURE_BASE_URL: !EXISTING_AZURE_BASE_URL!
set /p "INPUT_AZURE_BASE_URL=새 Azure AI Foundry Base URL 입력 (Enter=기존값 유지): "
set "FINAL_AZURE_BASE_URL=!EXISTING_AZURE_BASE_URL!"
if not "!INPUT_AZURE_BASE_URL!"=="" set "FINAL_AZURE_BASE_URL=!INPUT_AZURE_BASE_URL!"

echo.
echo [INFO] Azure OpenAI Base URL 예시: https://your-resource.openai.azure.com
echo [INFO] 현재 AZURE_OPENAI_BASE_URL: !EXISTING_AZURE_OPENAI_BASE_URL!
set /p "INPUT_AZURE_OPENAI_BASE_URL=새 Azure OpenAI Base URL 입력 (Enter=기존값 유지): "
set "FINAL_AZURE_OPENAI_BASE_URL=!EXISTING_AZURE_OPENAI_BASE_URL!"
if not "!INPUT_AZURE_OPENAI_BASE_URL!"=="" set "FINAL_AZURE_OPENAI_BASE_URL=!INPUT_AZURE_OPENAI_BASE_URL!"

echo.
echo [INFO] 현재 PORT: !EXISTING_PORT!
set /p "INPUT_PORT=프록시 포트 입력 (Enter=기존값 유지): "
set "FINAL_PORT=!EXISTING_PORT!"
if not "!INPUT_PORT!"=="" set "FINAL_PORT=!INPUT_PORT!"

echo.
echo 활성 모델 프로필을 선택하세요:
echo   [1] default
echo   [2] claude-to-gpt
echo   [3] model-router
echo [INFO] 현재 PROXY_MODEL_PROFILE: !EXISTING_PROXY_MODEL_PROFILE!
set /p "MODE_CHOICE=선택 (기본 1): "
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
echo [INFO] 입력값 검증 중...
powershell -NoProfile -Command ^
"$ErrorActionPreference='Stop';" ^
"$port = $env:NEW_PORT;" ^
"if (-not ($port -match '^[0-9]+$')) { Write-Host '[ERROR] PORT는 숫자여야 합니다.'; exit 1 }" ^
"$portNum = [int]$port;" ^
"if ($portNum -lt 1 -or $portNum -gt 65535) { Write-Host '[ERROR] PORT는 1~65535 범위여야 합니다.'; exit 1 }" ^
"$baseUrl = $env:NEW_AZURE_BASE_URL;" ^
"$openaiUrl = $env:NEW_AZURE_OPENAI_BASE_URL;" ^
"if (-not [Uri]::IsWellFormedUriString($baseUrl, [UriKind]::Absolute)) { Write-Host '[ERROR] AZURE_BASE_URL 형식이 올바르지 않습니다.'; exit 1 }" ^
"if (-not [Uri]::IsWellFormedUriString($openaiUrl, [UriKind]::Absolute)) { Write-Host '[ERROR] AZURE_OPENAI_BASE_URL 형식이 올바르지 않습니다.'; exit 1 }" ^
"$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $portNum };" ^
"if ($listeners) { Write-Host ('[ERROR] PORT ' + $portNum + ' 는 이미 사용 중입니다.'); exit 1 }" ^
"$excluded = netsh interface ipv4 show excludedportrange protocol=tcp 2>$null;" ^
"foreach ($line in $excluded) { if ($line -match '^\s*(\d+)\s+(\d+)') { $start=[int]$matches[1]; $count=[int]$matches[2]; $end=$start+$count-1; if ($portNum -ge $start -and $portNum -le $end) { Write-Host ('[ERROR] PORT ' + $portNum + ' 는 Windows 예약 포트 범위(' + $start + '-' + $end + ')에 포함됩니다.'); exit 1 } } }" ^
"$headers = @{ 'api-key' = $env:NEW_AZURE_API_KEY };" ^
"try { $resp = Invoke-WebRequest -Uri $baseUrl -Headers $headers -Method Head -TimeoutSec 10 -ErrorAction Stop; Write-Host ('[OK] AZURE_BASE_URL 응답 확인: ' + [int]$resp.StatusCode) } catch { $status = $_.Exception.Response.StatusCode.value__ 2>$null; if ($status) { Write-Host ('[WARN] AZURE_BASE_URL 응답 코드: ' + $status) } else { Write-Host ('[WARN] AZURE_BASE_URL 연결 확인 실패: ' + $_.Exception.Message) } }" ^
"try { $resp = Invoke-WebRequest -Uri $openaiUrl -Headers $headers -Method Head -TimeoutSec 10 -ErrorAction Stop; Write-Host ('[OK] AZURE_OPENAI_BASE_URL 응답 확인: ' + [int]$resp.StatusCode) } catch { $status = $_.Exception.Response.StatusCode.value__ 2>$null; if ($status) { Write-Host ('[WARN] AZURE_OPENAI_BASE_URL 응답 코드: ' + $status) } else { Write-Host ('[WARN] AZURE_OPENAI_BASE_URL 연결 확인 실패: ' + $_.Exception.Message) } }" ^
"if ([string]::IsNullOrWhiteSpace($env:NEW_AZURE_API_KEY)) { Write-Host '[WARN] AZURE_API_KEY 가 비어 있어 API 인증 검증은 건너뜁니다.' } else { Write-Host '[OK] API 키 입력값이 존재합니다.' }"
if %ERRORLEVEL% neq 0 (
    pause
    exit /b 1
)

powershell -NoProfile -Command ^
"$p='.env'; if (!(Test-Path $p)) { New-Item -ItemType File -Path $p | Out-Null }; $lines=Get-Content $p -ErrorAction SilentlyContinue; if(-not $lines){$lines=@()};" ^
"function Set-Key([string]$key,[string]$value){" ^
"  $prefix = $key + '=';" ^
"  $script:lines = @($script:lines | Where-Object { $_ -notmatch ('^' + [regex]::Escape($prefix)) });" ^
"  $script:lines += ($prefix + $value);" ^
"};" ^
"Set-Key 'AZURE_API_KEY' $env:NEW_AZURE_API_KEY;" ^
"Set-Key 'AZURE_BASE_URL' $env:NEW_AZURE_BASE_URL;" ^
"Set-Key 'AZURE_OPENAI_BASE_URL' $env:NEW_AZURE_OPENAI_BASE_URL;" ^
"Set-Key 'PORT' $env:NEW_PORT;" ^
"Set-Key 'PROXY_MODEL_PROFILE' $env:NEW_PROXY_MODEL_PROFILE;" ^
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
echo [INFO] Azure AI Foundry Base URL: !FINAL_AZURE_BASE_URL!
echo [INFO] Azure OpenAI Base URL: !FINAL_AZURE_OPENAI_BASE_URL!
echo [INFO] 포트: !FINAL_PORT!
echo [INFO] 활성 프로필: !DEFAULT_PROFILE!
echo [INFO] 실행: scripts\start.bat
echo.
pause
