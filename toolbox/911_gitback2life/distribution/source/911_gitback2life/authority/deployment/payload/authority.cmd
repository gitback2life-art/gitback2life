@echo off
rem G0a PROTOTYPE of the trusted launch boundary (design revision 3.3, section 14.1). NOT installed.
rem Run ONLY as:  C:\Windows\System32\cmd.exe /d /s /c ""<folder>\authority.cmd" <command> [<id>]"
rem /d skips the cmd AutoRun registry entries for THIS cmd. Nothing below starts a child cmd or a pipe.
setlocal DisableDelayedExpansion

rem 1. A PRIVATE scratch folder for this launch (G0a-F1). mkdir fails when the name already exists, so two launches
rem    can never share one. It is created under this folder, which is administrator-only when installed. Any failure
rem    here means Node is never started.
set "SCR="
set /a "TRY=0"
:mkscratch
set /a "TRY+=1"
if %TRY% gtr 20 goto :fail_scratch
set "SCR=%~dp0launch_scratch\%RANDOM%-%RANDOM%-%TRY%"
mkdir "%SCR%" 2>nul || goto :mkscratch
if not exist "%SCR%\" goto :fail_scratch

rem 2. Clear the ENTIRE environment except SCR (needed for the steps below; cleared on the launch line).
rem    The names are read back with the FILE form of for /f, which starts no process.
set > "%SCR%\env.lst" || goto :fail_scrub
if not exist "%SCR%\env.lst" goto :fail_scrub
for /f "usebackq delims==" %%v in ("%SCR%\env.lst") do if /i not "%%v"=="SCR" set "%%v="
set "SystemRoot=C:\Windows"
set "windir=C:\Windows"
set "SystemDrive=C:"
set "PATH=C:\Windows\System32"
set "TEMP=C:\Windows\Temp"
set "TMP=C:\Windows\Temp"

rem 3. PROVE the clearing worked: dump again and require EXACTLY the 7 expected names (the 6 fixed ones and SCR).
rem    An unreadable dump yields a count other than 7, so it fails closed rather than passing vacuously.
set > "%SCR%\check.lst" || goto :fail_scrub
set "N=0"
set "BAD="
for /f "usebackq delims==" %%v in ("%SCR%\check.lst") do (
  set "OK="
  if /i "%%v"=="SystemRoot" set "OK=1"
  if /i "%%v"=="windir" set "OK=1"
  if /i "%%v"=="SystemDrive" set "OK=1"
  if /i "%%v"=="PATH" set "OK=1"
  if /i "%%v"=="TEMP" set "OK=1"
  if /i "%%v"=="TMP" set "OK=1"
  if /i "%%v"=="SCR" set "OK=1"
  if defined OK (set /a "N+=1") else (set "BAD=1")
)
if defined BAD goto :fail_scrub
if not "%N%"=="7" goto :fail_scrub

rem 4. Remove the scratch folder (it held the original environment, values included) and confirm it is gone.
rmdir /s /q "%SCR%" 2>nul
if exist "%SCR%" goto :fail_cleanup
set "N="
set "OK="
set "BAD="
set "TRY="
cd /d "%~dp0"

rem 5. Arguments: at most 2; an explicit empty argument is refused; an absent optional one is OMITTED.
if not "%~3"=="" goto :too_many
if "%~1"=="" goto :empty
if "%~2"=="" if not "%2"=="" goto :empty
set "A1=%~1"
set "A2=%~2"
setlocal EnableDelayedExpansion
call :check A1 || exit /b 2
if defined A2 call :check A2 || exit /b 2

rem 6. Start Node. The validated values (only a-z, A-Z, 0-9 and -) are expanded into the line when it is read, and
rem    A1, A2 and SCR are cleared on that same line, so Node receives ONLY the 6 fixed variables.
if defined A2 goto :launch2
set "A1=" & set "SCR=" & "C:\Program Files\nodejs\node.exe" --no-addons --no-global-search-paths "%~dp0bootstrap.mjs" "%A1%"
exit /b %errorlevel%
:launch2
set "A1=" & set "A2=" & set "SCR=" & "C:\Program Files\nodejs\node.exe" --no-addons --no-global-search-paths "%~dp0bootstrap.mjs" "%A1%" "%A2%"
exit /b %errorlevel%

:check
rem Length <= 64, then strip each allowed character; anything left is refused. No findstr, no pipe.
set "R=!%1!"
if not "!R:~64!"=="" (echo authority: refused: argument longer than 64 characters 1>&2& exit /b 2)
for %%c in (a b c d e f g h i j k l m n o p q r s t u v w x y z 0 1 2 3 4 5 6 7 8 9 -) do if defined R set "R=!R:%%c=!"
if defined R (echo authority: refused: argument has characters other than a-z, 0-9 and - 1>&2& exit /b 2)
exit /b 0

:fail_scratch
echo authority: refused: could not create a private scratch folder; Node was not started 1>&2
exit /b 2
:fail_scrub
echo authority: refused: the environment could not be proven clear; Node was not started 1>&2
if defined SCR rmdir /s /q "%SCR%" 2>nul
exit /b 2
:fail_cleanup
echo authority: refused: the scratch folder could not be removed; Node was not started 1>&2
exit /b 2
:too_many
echo authority: refused: at most 2 arguments 1>&2
exit /b 2
:empty
echo authority: refused: empty argument 1>&2
exit /b 2
