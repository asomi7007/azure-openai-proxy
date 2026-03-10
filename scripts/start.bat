@echo off
chcp 65001 >nul 2>&1
:: Azure OpenAI Proxy 시작 스크립트
:: 어디서나 실행 가능 (더블클릭 또는 명령줄)

title Azure OpenAI Proxy
set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."

cd /d "%PROJECT_DIR%"

echo.
echo ========================================
echo   Azure OpenAI Proxy - Starting...
echo ========================================
echo.

:: Check if node is available
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js가 PATH에 없습니다.
    echo https://nodejs.org/ 에서 설치하세요.
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist "node_modules" (
    echo [INFO] 의존성 설치 중...
    npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] npm install 실패.
        pause
        exit /b 1
    )
    echo.
)

:: Check if config.yaml exists
if not exist "config.yaml" (
    echo [ERROR] config.yaml 파일이 없습니다.
    echo 프로젝트 루트에 config.yaml을 생성하세요.
    pause
    exit /b 1
)

:: Check if .env exists
if not exist ".env" (
    echo [WARN] .env 파일이 없습니다. AZURE_API_KEY 환경변수가 필요합니다.
    echo.
)

echo [INFO] 프록시 서버를 시작합니다...
echo [INFO] 중지: Ctrl+C 또는 scripts\stop.bat
echo.

node src/index.mjs

:: If node exits, pause so user can see the error
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] 프록시가 오류 코드 %ERRORLEVEL%로 종료되었습니다.
    pause
)
