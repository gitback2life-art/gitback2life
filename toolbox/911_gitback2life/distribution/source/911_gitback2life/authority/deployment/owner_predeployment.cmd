@echo off
rem Prepared owner-gated predeployment installer. Never self-elevates or authorizes M4.
rem Default action is read-only plan. Owner-only install requires a separate explicit gate.
setlocal DisableDelayedExpansion
set "PS=C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" (
  echo Refused: trusted PowerShell not found.
  exit /b 2
)
"%PS%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0owner_predeployment.ps1" -Plan
exit /b %ERRORLEVEL%
