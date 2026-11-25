@echo off
setlocal
set "TOS_NODE=node.exe"
if exist "%ProgramFiles%\nodejs\node.exe" set "TOS_NODE=%ProgramFiles%\nodejs\node.exe"
if exist "%~dp0.local\node\node.exe" set "TOS_NODE=%~dp0.local\node\node.exe"
"%TOS_NODE%" "%~dp0tools\open-local.mjs"
if not errorlevel 1 exit /b 0
echo.
echo Local test launch failed. See the error above and README.md.
pause
exit /b 1
