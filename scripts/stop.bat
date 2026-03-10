@echo off
chcp 65001 >nul 2>&1
echo Azure OpenAI Proxy 종료 중...

set "PROXY_PORT=8081"
set found=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PROXY_PORT%" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
    echo   PID %%a 종료
    set found=1
)

if %found%==0 (
    echo   실행 중인 프록시가 없습니다.
) else (
    echo 완료.
)
