@echo off
:: Azure OpenAI Proxy - 단일 파일 번들 빌드 스크립트
:: esbuild를 사용하여 모든 소스를 하나의 CJS 파일로 번들링

set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."

cd /d "%PROJECT_DIR%"

echo.
echo ========================================
echo   Azure OpenAI Proxy - Building...
echo ========================================
echo.

:: Check if node_modules exists
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    npm install
    echo.
)

:: Create dist directory
if not exist "dist" mkdir dist

:: Bundle with esbuild
echo [INFO] Bundling with esbuild...
npx esbuild src/index.mjs --bundle --platform=node --format=cjs --outfile=dist/proxy.cjs

if %ERRORLEVEL% equ 0 (
    echo.
    echo [SUCCESS] Bundle created: dist/proxy.cjs
    echo [INFO] Run with: node dist/proxy.cjs
    echo.
) else (
    echo.
    echo [ERROR] Build failed!
    echo.
)

pause
