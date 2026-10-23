@echo off
rem OWNER ONLY, after separately granted authorization, from an elevated console.
rem No automatic elevation and no production M4 activation.
setlocal DisableDelayedExpansion
"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%~dp0owner_predeployment.ps1" -Deploy
exit /b %ERRORLEVEL%
