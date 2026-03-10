@echo off
chcp 65001 >nul 2>&1
title Azure OpenAI Proxy Shell
set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."
set "PROXY_PORT=8081"
cd /d "%PROJECT_DIR%"

echo.
echo ==========================================
echo   Azure AI Foundry - Proxy Shell
echo ==========================================
echo.

:: Node.js 확인
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js가 설치되어 있지 않습니다.
    echo https://nodejs.org/ 에서 설치하세요.
    pause
    exit /b 1
)

:: node_modules 확인
if not exist "node_modules" (
    echo [INFO] 의존성 설치 중...
    npm install
    echo.
)

:: 기존 프록시 프로세스 종료
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PROXY_PORT%" ^| findstr "LISTENING" 2^>nul') do (
    echo 기존 프록시 종료 (PID: %%a)...
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: 프록시 백그라운드 시작
echo [1/2] 프록시 시작 중...
start "AzureOpenAIProxy" /MIN cmd /c "cd /d "%PROJECT_DIR%" && node src/index.mjs 2>&1"
timeout /t 3 /nobreak >nul

:: 헬스체크
curl -s http://localhost:%PROXY_PORT%/health >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] 프록시 시작 실패.
    echo 별도 터미널에서 확인하세요: node src/index.mjs
    pause
    exit /b 1
)
echo [OK] 프록시 실행 중: http://localhost:%PROXY_PORT%

:: 환경변수 설정
echo [2/2] 환경변수 설정 완료
set ANTHROPIC_BASE_URL=http://localhost:%PROXY_PORT%
set ANTHROPIC_API_KEY=azure-proxy-key
set OPENAI_BASE_URL=http://localhost:%PROXY_PORT%/openai
set OPENAI_API_KEY=azure-proxy-key

echo.
echo   ANTHROPIC_BASE_URL=%ANTHROPIC_BASE_URL%
echo   ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY%
echo   OPENAI_BASE_URL=%OPENAI_BASE_URL%
echo   OPENAI_API_KEY=%OPENAI_API_KEY%
echo.
echo ==========================================
echo   이 창에서 claude 또는 다른 도구를 실행하세요.
echo   종료: scripts\stop.bat 실행 또는 창 닫기
echo ==========================================
echo.

cmd /k
