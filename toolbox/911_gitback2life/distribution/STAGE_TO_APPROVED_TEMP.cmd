@echo off
setlocal DisableDelayedExpansion
rem Stage a verified independent copy in the existing project Temp (if present),
rem otherwise per-user LocalAppData. Never elevate, activate, overwrite or edit case data.
set "STAGER=%~dp0STAGE_TO_APPROVED_TEMP.ps1"
set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL%" (
  echo Windows PowerShell 5.1 was not found. No files copied.
  pause
  exit /b 2
)
"%POWERSHELL%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%STAGER%"
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" echo Staging refused or failed. Nothing was installed or activated.
pause
endlocal & exit /b %RC%
