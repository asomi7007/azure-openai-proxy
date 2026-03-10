@echo off
chcp 65001 >nul 2>&1
title Azure Claude Code Launcher
set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."
set "PROXY_PORT=8081"
cd /d "%PROJECT_DIR%"

echo.
echo ==========================================
echo   Azure AI Foundry - Claude Code Launcher
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
    echo 기존 프록시 프로세스 종료 (PID: %%a)...
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: 프록시 백그라운드 시작
echo [1/3] 프록시 서버 시작 중...
start "AzureOpenAIProxy" /MIN cmd /c "cd /d "%PROJECT_DIR%" && node src/index.mjs 2>&1"
timeout /t 3 /nobreak >nul

:: 헬스체크
curl -s http://localhost:%PROXY_PORT%/health >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] 프록시 서버가 시작되지 않았습니다.
    echo 별도 터미널에서 실행해서 에러를 확인하세요:
    echo   node src/index.mjs
    pause
    exit /b 1
)
echo [OK] 프록시 실행 중: http://localhost:%PROXY_PORT%

:: 환경변수 설정
echo [2/3] 환경변수 설정 중...
set ANTHROPIC_BASE_URL=http://localhost:%PROXY_PORT%
set ANTHROPIC_API_KEY=azure-proxy-key
set OPENAI_BASE_URL=http://localhost:%PROXY_PORT%/openai
set OPENAI_API_KEY=azure-proxy-key
echo [OK] ANTHROPIC_BASE_URL=%ANTHROPIC_BASE_URL%
echo [OK] OPENAI_BASE_URL=%OPENAI_BASE_URL%

:: Claude Code 실행
echo [3/3] Claude Code 시작...
echo.
echo   Proxy: http://localhost:%PROXY_PORT%
echo   Models: claude-opus-4-6, claude-sonnet-4-5, gpt-5.3-codex
echo.
echo ==========================================
echo.

claude

echo.
echo ==========================================
echo Claude Code 종료. 프록시 정리 중...

:: 프록시 종료
taskkill /FI "WINDOWTITLE eq AzureOpenAIProxy" /F >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PROXY_PORT%" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)

echo 완료.
timeout /t 2 /nobreak >nul
