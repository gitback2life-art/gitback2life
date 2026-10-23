@echo off
setlocal DisableDelayedExpansion
rem Offline development launcher; no installation, elevation, or activation.
rem Do NOT redirect Node stderr into the same file the Node diagnostics module opens.
rem Windows can lock an inherited CMD redirection handle and cause EBUSY.
rem With no arguments show the small mouse/number-key desktop interface.
rem Numeric GUI selections re-enter this file using --menu-action; existing
rem interactive confirmations and all scope/authority rules remain unchanged.
if "%~1"=="" goto :SHOW_UI
if /I "%~1"=="--menu-action" goto :CONSOLE
goto :CONSOLE
:SHOW_UI
set "GUI_SCRIPT=%~dp0toolbox\ToolboxUI.ps1"
set "GUI_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%GUI_SCRIPT%" (
  echo ERROR: Toolbox interface is missing.
  pause
  exit /b 2
)
if not exist "%GUI_POWERSHELL%" (
  echo ERROR: Windows PowerShell is required for the toolbox interface.
  pause
  exit /b 2
)
start "" "%GUI_POWERSHELL%" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%GUI_SCRIPT%"
if errorlevel 1 (
  echo ERROR: Could not open the Toolbox interface.
  pause
  exit /b 2
)
exit /b 0
:CONSOLE
set "ROOT=%~dp0"
set "LOGDIR=%ROOT%Temp\Logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
if not exist "%LOGDIR%" (
  echo ERROR: Cannot create diagnostic log directory "%LOGDIR%".
  echo No installation or activation was performed.
  pause
  exit /b 2
)
set "GB2L_TOOLBOX_RUN_ID=%RANDOM%_%RANDOM%_%RANDOM%"
set "LAUNCHLOG=%LOGDIR%\launcher_%GB2L_TOOLBOX_RUN_ID%.log"
set "APPLOG=%LOGDIR%\toolbox_%GB2L_TOOLBOX_RUN_ID%.log"
set "ERRLOG=%LOGDIR%\node_stderr_%GB2L_TOOLBOX_RUN_ID%.log"
set "RC=0"
>>"%LAUNCHLOG%" echo [LAUNCH] Ordinary offline toolbox development build. No installation or activation.
>>"%LAUNCHLOG%" echo [LAUNCH] Date/time: %DATE% %TIME%
>>"%LAUNCHLOG%" echo [LAUNCH] Diagnostic streams use separate files to prevent Windows sharing conflicts.
pushd "%ROOT%" 2>>"%LAUNCHLOG%"
if errorlevel 1 (
  echo ERROR: Could not access extracted toolbox folder.
  >>"%LAUNCHLOG%" echo [ERROR] Failed to enter toolbox folder.
  set "RC=2"
  goto :FINISH
)
where node.exe >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js 22 or newer is required.
  >>"%LAUNCHLOG%" echo [ERROR] node.exe was not found on PATH.
  set "RC=2"
  goto :DONE
)
node.exe -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" 2>>"%LAUNCHLOG%"
if errorlevel 1 (
  echo ERROR: Node.js 22 or newer is required.
  >>"%LAUNCHLOG%" echo [ERROR] Node.js version check failed.
  node.exe --version >>"%LAUNCHLOG%" 2>&1
  set "RC=2"
  goto :DONE
)
rem Only the Node process writes APPLOG. Its stderr goes to an independent file.
rem Neither APPLOG nor ERRLOG is open for redirection while app diagnostics append.
node.exe "%ROOT%toolbox\toolbox.mjs" %* 2>>"%ERRLOG%"
set "RC=%errorlevel%"
if not "%RC%"=="0" echo Toolbox exited with error code %RC%.
:DONE
popd
:FINISH
>>"%LAUNCHLOG%" echo [LAUNCH] Exit code: %RC%
where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo WARNING: PowerShell is unavailable; support ZIP could not be created.
  >>"%LAUNCHLOG%" echo [WARNING] PowerShell not found.
) else (
  rem Collector output is separate; never write to a log while it is being ZIPped.
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%ROOT%toolbox\make_support_zip.ps1" -LaunchLog "%LAUNCHLOG%" -AppLog "%APPLOG%" -StderrLog "%ERRLOG%" -RunId "%GB2L_TOOLBOX_RUN_ID%" -ExitCode %RC% >"%LOGDIR%\collector_%GB2L_TOOLBOX_RUN_ID%.log" 2>&1
  if errorlevel 1 (
    echo WARNING: Support ZIP creation failed. See the collector log in Temp\Logs.
  )
  type "%LOGDIR%\collector_%GB2L_TOOLBOX_RUN_ID%.log"
)
echo.
echo Diagnostic logs: "%LOGDIR%"
echo No installation or activation was performed by this launcher.
pause
endlocal & exit /b %RC%
