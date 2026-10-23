@echo off
setlocal DisableDelayedExpansion
rem Run only on a consenting client's Windows computer. No remote connection.
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" (
  echo Windows PowerShell was not found. Nothing collected.
  pause
  exit /b 2
)
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Client_Device_Collector.ps1"
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" echo Collector did not complete. No security setting was changed.
pause
endlocal & exit /b %RC%
