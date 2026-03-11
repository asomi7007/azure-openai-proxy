@echo off
chcp 65001 >nul 2>&1
:: Claude 모델 요청을 Azure model-router 배포로 변환하는 프로필로 시작
set "SCRIPT_DIR=%~dp0"
call "%SCRIPT_DIR%start.bat" model-router
